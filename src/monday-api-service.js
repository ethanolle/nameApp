import initMondayClient from 'monday-sdk-js';
import { Logger } from '@mondaycom/apps-sdk';

const logTag = 'Middleware';
const logger = new Logger(logTag);

export const getColumnValue = async (token, itemId, columnId) => {
  try {
    const mondayClient = initMondayClient();
    mondayClient.setApiVersion('2024-01');
    mondayClient.setToken(token);

    const query = `query($itemId: [ID!], $columnId: [String!]) {
          items (ids: $itemId) {
            column_values(ids:$columnId) {
              value
            }
          }
        }`;
    const variables = { columnId, itemId };

    const response = await mondayClient.api(query, { variables });
    return response.data.items[0].column_values[0].value;
  } catch (err) {
    logger.error(err);
  }
};

export const calculateIsToComplex = async (jobData) => {
  const { payload } = jobData;
  try {
    // setup the tokens
    const mondayClient = initMondayClient({ token: payload.shortLivedToken });
    mondayClient.setApiVersion('2024-01');
    // Check complexity before proceeding
    const complexityQuery = `query {
      complexity {
        before
        query 
        after
      }
    }`;

    const complexityResult = await mondayClient.api(complexityQuery);

    if (complexityResult.errors) {
      throw new Error(`Failed to fetch complexity: ${complexityResult.errors}`);
    }
    const { before, query: queryComplexity } = complexityResult.data.complexity;

    if (before < 1000000 || queryComplexity > 5000000) {
      logger.warn('Complexity limits approaching threshold', {
        remainingComplexity: before,
        queryComplexity,
      });
      return true; // Signal that processing should be delayed
    }

    return false; // Safe to proceed with processing
  } catch (err) {
    logger.error(err);
    throw err;
  }
};

export const changeColumnValue = async (token, boardId, itemId, columnId, value) => {
  try {
    const mondayClient = initMondayClient({ token });
    mondayClient.setApiVersion('2024-01');

    const query = `mutation change_column_value($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
          change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
            id
          }
        }
        `;
    const variables = { boardId, columnId, itemId, value };

    const response = await mondayClient.api(query, { variables });
    return response;
  } catch (err) {
    logger.error(err);
  }
};

export async function updateItemName(itemId, boardId, newItemName, mondayClient) {
  try {
    const changeNameMutation = `
      mutation ($itemId: ID!, $boardId: ID!, $columnId: String!, $value: String) {
        change_simple_column_value(item_id: $itemId, board_id: $boardId, column_id: $columnId, value: $value) {
          id
        }
      }
    `;
    const changeNameVariables = {
      itemId,
      boardId,
      columnId: 'name',
      value: newItemName,
    };
    await mondayClient.api(changeNameMutation, { variables: changeNameVariables });
  } catch (err) {
    logger.error(err);
  }
}

// Helper function to fetch and process column values
export async function fetchColumnValues(itemId, columnIds, mondayClient) {
  try {
    const itemQuery = `
      query ($itemId: [ID!], $columnIds: [String!]) {
        items(ids: $itemId) {
          column_values(ids: $columnIds) {
            id
            type
            ... on MirrorValue {
              display_value
            }
            text
            value
          }
        }
      }
    `;

    const itemVariables = { itemId, columnIds };
    const itemResponse = await mondayClient.api(itemQuery, { variables: itemVariables });
    const columnValues = itemResponse.data.items[0].column_values;

    // Normalize values, prioritizing display_value for mirrored columns
    const normalizedColumnValues = columnValues.map((column) => {
      if (column.type === 'mirror' && column.display_value) {
        return { ...column, value: column.display_value, text: column.display_value };
      }
      return column;
    });

    return normalizedColumnValues;
  } catch (err) {
    logger.error(err);
  }
}

// Helper function to fetch board columns with types and settings
export async function fetchBoardColumns(shortLivedToken, boardId) {
  try {
    const mondayClient = initMondayClient();
    mondayClient.setApiVersion('2024-01');
    mondayClient.setToken(shortLivedToken);

    // Get columns of the board
    const columnsQuery = `
      query ($boardId: [ID!]) {
        boards(ids: $boardId) {
          columns {
            id
            title
            type
            settings_str
          }
        }
      }
    `;
    const columnsVariables = { boardId };
    const columnsResponse = await mondayClient.api(columnsQuery, { variables: columnsVariables });
    if (columnsResponse.errors) {
      throw new Error(`Failed to fetch board columns: ${columnsResponse.errors}`);
    }
    const boardColumns = columnsResponse.data.boards[0].columns;

    return { boardColumns, mondayClient };
  } catch (err) {
    logger.error(`Failed to fetch board columns: ${err.message}`);
    throw new Error(`Failed to fetch board columns: ${err.message}`);
  }
}
