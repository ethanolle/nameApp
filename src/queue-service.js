import { Logger } from '@mondaycom/apps-sdk';
import { fetchBoardColumns, fetchColumnValues, updateItemName } from './monday-api-service.js';

const logTag = 'QueueService';
const logger = new Logger(logTag);

export const processMessage = async (messageData) => {
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
    logger.info(`Token length: ${shortLivedToken ? shortLivedToken.length : 0}`);

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
