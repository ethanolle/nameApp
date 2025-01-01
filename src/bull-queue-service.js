import Bull from 'bull';
import { Logger } from '@mondaycom/apps-sdk';
import { processMessage } from './queue-service.js';
import { calculateIsToComplex } from './monday-api-service.js';
import dotenv from 'dotenv';

dotenv.config();

const logger = new Logger('BullQueueService');

// Create a single queue
const queue = new Bull(
  'monday_queue',
  process.env.REDIS_URL || 'rediss://red-cr5gbgjv2p9s73agpujg:UkieSVapBPkLE8uaqdy9mMCNsbAit2Ic@oregon-redis.render.com:6379',
  {
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000,
      },
      removeOnComplete: true,
      removeOnFail: true,
    },
    limiter: {
      max: 150, // Process up to 150 jobs
      duration: 60000, // Per minute
    },
    settings: {
      lockDuration: 600000, // 60 seconds
      stalledInterval: 30000,
      maxStalledCount: 2,
      lockRenewTime: 15000,
      drainDelay: 5,
    },
    redis: {
      maxRetriesPerRequest: 3,
      connectTimeout: 30000,
      enableReadyCheck: false,
      retryStrategy: (times) => {
        const delay = Math.min(times * 500, 2000);
        logger.info(`Retrying Redis connection in ${delay}ms... Attempt: ${times}`);
        return delay;
      },
      tls: {
        rejectUnauthorized: false,
        requestCert: true,
      },
    },
  },
);

// Process jobs with rate limiting
queue.process(15, async (job) => {
  try {
    let isToComplex = false;
    try {
      isToComplex = await calculateIsToComplex(job.data);
    } catch (error) {
      logger.error('Failed to calculate complexity:', error);

      if (error.message.includes('Not Authenticated') || error.message.includes('Invalid or expired token')) {
        await job.remove();
        return { success: false, reason: 'Authentication failed - job deleted' };
      }

      const delay = 60000; // 2 minute delay
      await job.moveToDelayed(Date.now() + delay);
      return { success: true, delayed: true };
    }

    if (isToComplex) {
      const delay = 30000;
      await job.moveToDelayed(Date.now() + delay);
      logger.info(`Complexity limit reached, job delayed by 30 seconds`);
      return { success: true, delayed: true };
    }

    const result = await processMessage(JSON.stringify(job.data));
    return result;
  } catch (error) {
    logger.error('Error processing job:', error);
    throw error;
  }
});

// Enhanced error handling
queue.on('error', (error) => {
  logger.error('Queue error details:', {
    error: error.message,
    code: error.code,
    stack: error.stack,
    timestamp: new Date().toISOString(),
  });

  console.log(error);
});

queue.on('failed', (job, error) => {
  logger.error(`Job ${job.id} failed:`, {
    error: error.message,
    stack: error.stack,
    jobData: {
      ...job.data,
      metadata: job.data.metadata,
    },
    attempts: job.attemptsMade,
    timestamp: new Date().toISOString(),
  });
});

queue.on('completed', (job) => {
  logger.info(`Job ${job.id} completed successfully`);
});

// Connection status logging
queue.on('ready', () => {
  logger.info('Redis connection established successfully');
});

queue.on('connecting', () => {
  logger.info('Attempting to connect to Redis...');
});

queue.on('reconnecting', () => {
  logger.warn('Redis connection lost, attempting to reconnect...');
});

// Clean old jobs periodically
queue.clean(24 * 3600 * 1000, 'completed');
queue.clean(24 * 3600 * 1000, 'failed');

// Add job to the queue
export const addToQueue = async (message) => {
  try {
    const job = await queue.add(message);
    logger.info(`Job ${job.id} added to queue`);
    return job.id;
  } catch (error) {
    logger.error('Error adding job to queue:', error);
    throw error;
  }
};

// Get queue status
export const getQueueStatus = async () => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      queue: {
        waiting,
        active,
        completed,
        failed,
        delayed,
      },
    };
  } catch (error) {
    logger.error('Error getting queue status:', error);
    throw error;
  }
};

// Graceful shutdown
const cleanup = async () => {
  try {
    await queue.close();
    process.exit(0);
  } catch (error) {
    logger.error('Error during cleanup:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
