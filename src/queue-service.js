import { Logger } from '@mondaycom/apps-sdk';
import { fetchBoardColumns, fetchColumnValues, updateItemName } from './monday-api-service.js';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const logTag = 'QueueService';
const logger = new Logger(logTag);

// Constants
const QUEUE_NAME = 'my_queue';
const DLQ_NAME = 'my_queue_dlq';
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;
const CONCURRENT_MESSAGES = 3;
const BATCH_SIZE = 10; // Process 10 messages at once
const BATCH_DELAY = 1000; // 1 second delay between batches to prevent API overload
const CONCURRENT_BATCHES = 3; // Number of batches to process simultaneously

// Initialize Redis client with more detailed error handling and connection management
const redisClient = new Redis(process.env.REDIS_URL, {
  tls: {
    rejectUnauthorized: false,
  },
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    if (times > 5) {
      logger.error('Max Redis reconnection attempts reached');
      return null;
    }
    return Math.min(times * 1000, 5000);
  },
  reconnectOnError: (err) => {
    logger.error('Redis reconnect on error:', err);
    return true;
  },
});

// Add more detailed connection event handlers
redisClient.on('connect', () => {
  logger.info('Connected to Redis');
});

redisClient.on('ready', () => {
  logger.info('Redis client is ready');
});

redisClient.on('error', (error) => {
  logger.error('Redis connection error:', error);
});

redisClient.on('close', () => {
  logger.warn('Redis connection closed');
});

// Graceful shutdown handling
const cleanup = async () => {
  logger.info('Shutting down queue service...');
  if (redisClient) {
    await redisClient.quit();
  }
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Added connection check helper
const ensureConnection = async () => {
  if (redisClient.status !== 'ready') {
    logger.warn('Redis not ready, attempting to reconnect...');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (redisClient.status !== 'ready') {
      throw new Error('Redis connection not available');
    }
  }
};

const validateMessage = (message) => {
  try {
    const parsed = JSON.parse(message);
    return (
      parsed && parsed.shortLivedToken && parsed.inputFields && parsed.inputFields.boardId && parsed.inputFields.itemId && parsed.inputFields.text
    );
  } catch (error) {
    logger.error('Message validation error:', error);
    return false;
  }
};

const moveToDeadLetterQueue = async (message, error) => {
  try {
    await ensureConnection();
    const dlqMessage = JSON.stringify({
      originalMessage: message,
      error: error.message,
      timestamp: Date.now(),
    });
    const result = await redisClient.rpush(DLQ_NAME, dlqMessage);
    if (!result) {
      throw new Error('Failed to push message to DLQ');
    }
    logger.info('Message successfully moved to DLQ');
  } catch (error) {
    logger.error('Error moving message to DLQ:', error);
  }
};

export const produceMessage = async (message) => {
  try {
    await ensureConnection();

    if (!validateMessage(message)) {
      throw new Error('Invalid message format');
    }

    const timestamp = Date.now();
    const messageWithMetadata = {
      payload: JSON.parse(message),
      metadata: {
        timestamp,
        retryCount: 0,
      },
    };

    // Add explicit error handling for rpush
    const result = await redisClient.rpush(QUEUE_NAME, JSON.stringify(messageWithMetadata));
    if (!result) {
      throw new Error('Failed to push message to queue');
    }

    logger.info(`Message successfully published to Redis queue with result: ${result}`);
    return timestamp; // Return just the timestamp
  } catch (error) {
    logger.error('Error producing message:', error);
    throw error;
  }
};

const processMessage = async (messageData) => {
  try {
    const parsedMessage = JSON.parse(messageData);
    const messageTimestamp = parsedMessage.metadata && parsedMessage.metadata.timestamp;
    const currentTime = Date.now();
    const tenMinutesInMs = 10 * 60 * 1000;

    // Check if message is older than 10 minutes
    if (messageTimestamp && currentTime - messageTimestamp > tenMinutesInMs) {
      logger.warn('Discarding message older than 10 minutes', {
        messageAge: (currentTime - messageTimestamp) / 1000,
        messageTimestamp,
      });
      return { success: false, reason: 'Message expired' };
    }

    const { payload } = parsedMessage;
    const { shortLivedToken, inputFields } = payload;
    const { boardId, itemId, text } = inputFields;

    // Add debug logging
    logger.info(`Processing message with boardId: ${boardId}, itemId: ${itemId}`);
    logger.info(`Token length: ${shortLivedToken?.length || 0}`);

    logger.info(`Processing message for item ${itemId} on board ${boardId}`);

    // Fetch board columns
    const { boardColumns, mondayClient } = await fetchBoardColumns(shortLivedToken, boardId);
    if (!boardColumns || boardColumns.length === 0) {
      throw new Error('No columns found for the board');
    }

    const columnNameToIdMap = {};
    boardColumns.forEach((column) => {
      columnNameToIdMap[column.title] = column.id;
    });

    const columnNames = text.split(',').map((name) => name.trim());
    const columnIds = columnNames.map((name) => columnNameToIdMap[name]);
    const undefinedColumns = columnNames.filter((name, index) => !columnIds[index]);

    if (undefinedColumns.length > 0) {
      throw new Error(`Columns not found: ${undefinedColumns.join(', ')}`);
    }

    const columnValues = await fetchColumnValues(itemId, columnIds, mondayClient, boardColumns);
    if (!columnValues) {
      throw new Error('Failed to fetch column values');
    }

    const columnValueTexts = columnValues.map((columnValue) => columnValue.text);
    const newItemName = columnValueTexts.join('_');

    await updateItemName(itemId, boardId, newItemName, mondayClient);
    logger.info(`Item name updated successfully for item ID ${itemId}`);

    return { success: true };
  } catch (error) {
    logger.error('Error in processMessage:', error);
    throw error;
  }
};

const retryMessage = async (messageData) => {
  try {
    const parsedMessage = JSON.parse(messageData);
    parsedMessage.metadata.retryCount += 1;
    logger.info(`Retry attempt ${parsedMessage.metadata.retryCount} for message`);

    if (parsedMessage.metadata.retryCount <= MAX_RETRIES) {
      const delay = RETRY_DELAY * parsedMessage.metadata.retryCount;
      await new Promise((resolve) => setTimeout(resolve, delay));

      const result = await redisClient.rpush(QUEUE_NAME, JSON.stringify(parsedMessage));
      if (!result) {
        throw new Error('Failed to requeue message');
      }

      logger.info(`Message requeued for retry ${parsedMessage.metadata.retryCount}/${MAX_RETRIES}`);
    } else {
      await moveToDeadLetterQueue(messageData, new Error('Max retries exceeded'));
    }
  } catch (error) {
    logger.error('Error in retryMessage:', error);
    await moveToDeadLetterQueue(messageData, error);
  }
};

export const processMessages = async () => {
  const fetchBatch = async () => {
    const messages = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const message = await redisClient.blpop(QUEUE_NAME, 1);
      if (message) {
        messages.push(message[1]);
      }
    }
    return messages;
  };

  const processBatch = async () => {
    try {
      await ensureConnection();

      // Fetch multiple batches
      const batchPromises = Array(CONCURRENT_BATCHES)
        .fill()
        .map(() => fetchBatch());
      const batches = await Promise.all(batchPromises);
      const allMessages = batches.flat().filter(Boolean);

      if (allMessages.length > 0) {
        logger.info(`Processing batch of ${allMessages.length} messages`);

        // Process messages in chunks to prevent API overload
        const chunks = [];
        for (let i = 0; i < allMessages.length; i += BATCH_SIZE) {
          chunks.push(allMessages.slice(i, i + BATCH_SIZE));
        }

        for (const chunk of chunks) {
          await Promise.all(
            chunk.map(async (messageData) => {
              try {
                const result = await processMessage(messageData);
                if (result.success) {
                  logger.info('Successfully processed message');
                } else {
                  logger.warn(`Message processing completed with status: ${result.reason}`);
                }
              } catch (error) {
                logger.error('Error processing message:', error);
                await retryMessage(messageData);
              }
            }),
          );
          // Add delay between chunks to prevent API rate limiting
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
        }
      }
    } catch (error) {
      logger.error('Error in batch processing:', error);
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
    }
    setTimeout(processBatch, 100);
  };

  processBatch();
};

// Queue monitoring helper
export const getQueueStatus = async () => {
  try {
    await ensureConnection();
    const queueLength = await redisClient.llen(QUEUE_NAME);
    const dlqLength = await redisClient.llen(DLQ_NAME);
    return {
      queueLength,
      dlqLength,
      redisStatus: redisClient.status,
      lastChecked: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Error getting queue status:', error);
    throw error;
  }
};

// Export Redis client for testing purposes
export const getRedisClient = () => redisClient;

// Add this new function for synchronous message processing
export const processSingleMessage = async (messageData) => {
  try {
    const result = await processMessage(messageData);
    if (!result.success) {
      throw new Error(result.reason || 'Message processing failed');
    }
    return result;
  } catch (error) {
    logger.error('Error in processSingleMessage:', error);
    throw error;
  }
};
