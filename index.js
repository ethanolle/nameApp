import express from 'express';
import { Logger } from '@mondaycom/apps-sdk';
import { transformText } from './src/transformation-service.js';
import { authorizeRequest } from './src/middleware.js';
import { changeColumnValue, getColumnValue } from './src/monday-api-service.js';
import { getSecret, isDevelopmentEnv, getEnv } from './src/helpers.js';
import { addToQueue } from './src/bull-queue-service.js';
import dotenv from 'dotenv';

dotenv.config();

const logTag = 'ExpressServer';
const PORT = 'PORT';
const SERVICE_TAG_URL = 'SERVICE_TAG_URL';
const TO_UPPER_CASE = 'TO_UPPER_CASE';
const TO_LOWER_CASE = 'TO_LOWER_CASE';

const logger = new Logger(logTag);
const currentPort = getSecret(PORT);
const currentUrl = getSecret(SERVICE_TAG_URL);

const app = express();
app.use(express.json());

// Basic health check
app.get('/', (req, res) => {
  res.status(200).send({ message: 'healthy' });
});

// Text transformation endpoint
app.post('/monday/execute_action', authorizeRequest, async (req, res) => {
  logger.info(
    JSON.stringify({
      message: 'New request received',
      path: '/action',
      body: req.body,
      headers: req.headers,
    }),
  );

  try {
    const { shortLivedToken } = req.session;
    const { payload } = req.body;
    const { inputFields } = payload;
    const { boardId, itemId, sourceColumnId, targetColumnId } = inputFields;

    const text = await getColumnValue(shortLivedToken, itemId, sourceColumnId);
    if (!text) {
      return res.status(200).json({
        success: true,
      });
    }

    const transformationTypeValue = inputFields.transformationType && inputFields.transformationType.value;
    const transformedText = transformText(text, transformationTypeValue || 'TO_UPPER_CASE');
    await changeColumnValue(shortLivedToken, boardId, itemId, targetColumnId, transformedText);

    return res.status(200).json({
      success: true,
    });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({
      success: false,
      severityCode: 4000,
      notificationErrorTitle: 'Text Transformation Failed',
      notificationErrorDescription: 'Failed to transform the text. Please check the column values and try again.',
      runtimeErrorDescription: 'Error occurred during text transformation action.',
    });
  }
});

// Item name update endpoint
app.post('/monday/execute_action_item_name', authorizeRequest, async (req, res) => {
  try {
    const { shortLivedToken } = req.session;
    const { payload } = req.body;
    const { inputFields } = payload;

    const messagePayload = {
      payload: {
        shortLivedToken,
        inputFields: {
          boardId: inputFields.boardId.toString(),
          itemId: inputFields.itemId.toString(),
          text: inputFields.text.toString(),
        },
      },
      metadata: {
        timestamp: Date.now(),
        retryCount: 0,
        actId: req.session.accountId, // Add account ID for rate limiting
      },
    };

    try {
      const jobId = await addToQueue(messagePayload);

      // Return success response in Monday.com's expected format
      return res.status(200).json({
        success: true,
        data: {
          jobId,
          itemId: inputFields.itemId,
          boardId: inputFields.boardId,
        },
      });
    } catch (produceError) {
      logger.error('Failed to add message to queue:', produceError);
      // Return medium severity error
      return res.status(422).json({
        success: false,
        severityCode: 4000,
        notificationErrorTitle: 'Failed to Queue Action',
        notificationErrorDescription: 'Unable to process the item name update at this time. Please try again.',
        runtimeErrorDescription: 'Failed to queue the item name update action in the message queue.',
      });
    }
  } catch (err) {
    logger.error('Error in execute_action_item_name:', err);
    // Return high severity error
    return res.status(500).json({
      success: false,
      severityCode: 6000,
      notificationErrorTitle: 'System Error',
      notificationErrorDescription: 'A critical error occurred while processing your request. Please contact support.',
      runtimeErrorDescription: 'Internal server error while processing item name update action.',
    });
  }
});

// Get transformation options endpoint
app.post('/monday/get_remote_list_options', authorizeRequest, async (req, res) => {
  const TRANSFORMATION_TYPES = [
    { title: 'to upper case', value: TO_UPPER_CASE },
    { title: 'to lower case', value: TO_LOWER_CASE },
  ];

  try {
    return res.status(200).send(TRANSFORMATION_TYPES);
  } catch (err) {
    logger.error(err);
    return res.status(500).send({ message: 'internal server error' });
  }
});

// Test endpoint for producing messages directly
app.post('/produce', async (req, res) => {
  try {
    const messageId = await addToQueue({
      payload: req.body,
      metadata: {
        timestamp: Date.now(),
        retryCount: 0,
        actId: req.body.actId || 'test-account', // For testing purposes
      },
    });
    return res.status(200).send({ messageId });
  } catch (err) {
    logger.error(JSON.stringify(err));
    return res.status(500).send({ message: 'internal server error' });
  }
});

// Note: Queue processors are automatically initialized in bull-queue-service.js

// Start server
app.listen(currentPort, () => {
  if (isDevelopmentEnv()) {
    logger.info(`app running locally on port ${currentPort}`);
  } else {
    logger.info(`up and running listening on port:${currentPort}`, 'server_runner', {
      env: getEnv(),
      port: currentPort,
      url: `https://${currentUrl}`,
    });
  }
});
