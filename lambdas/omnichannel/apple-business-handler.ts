import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'crypto';
import * as crypto from 'crypto';

const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});
const secretsManager = new SecretsManagerClient({});

const MESSAGE_LOG_TABLE = process.env.MESSAGE_LOG_TABLE!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const APPLE_SECRETS_ARN = process.env.APPLE_SECRETS_ARN!;
const APPLE_BUSINESS_ID = process.env.APPLE_BUSINESS_ID!;

interface AppleMessage {
  id: string;
  sourceId: string;
  destinationId: string;
  body?: string;
  interactiveData?: any;
  capabilities?: string[];
}

interface InteractivePayload {
  type: 'timePicker' | 'listPicker' | 'richLink' | 'quickReply';
  data: any;
}

/**
 * Apple Messages for Business Handler
 *
 * Handles Apple Messages for Business communications:
 * - Process inbound messages via webhook
 * - Send outbound messages including interactive types
 * - Support Time Picker, List Picker, Rich Links, Quick Replies
 * - Handle typing indicators and read receipts
 * - Manage conversation authentication
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Apple Business Handler Event:', JSON.stringify(event, null, 2));

  try {
    // Handle webhook from Apple
    if (event.httpMethod || event.requestContext?.http?.method) {
      return handleWebhook(event);
    }

    // Handle EventBridge events
    if (event.source?.startsWith('medcx')) {
      return handleEventBridgeEvent(event);
    }

    // Handle direct invocations
    const { action, ...data } = event;

    switch (action) {
      case 'sendMessage':
        return sendMessage(data);

      case 'sendTimePicker':
        return sendTimePicker(data);

      case 'sendListPicker':
        return sendListPicker(data);

      case 'sendRichLink':
        return sendRichLink(data);

      case 'sendQuickReplies':
        return sendQuickReplies(data);

      case 'sendTypingIndicator':
        return sendTypingIndicator(data);

      case 'closeConversation':
        return closeConversation(data);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in Apple Business handler:', error);
    return {
      error: 'Apple Business operation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Handle webhook from Apple
 */
async function handleWebhook(event: any): Promise<any> {
  const method = event.httpMethod || event.requestContext?.http?.method;

  // Handle verification
  if (method === 'GET') {
    return {
      statusCode: 200,
      body: event.queryStringParameters?.challenge || 'ok',
    };
  }

  // Verify signature
  const signature = event.headers?.['x-apple-signature'] || event.headers?.['X-Apple-Signature'];
  const body = event.body;

  if (!await verifySignature(body, signature)) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid signature' }),
    };
  }

  const payload = JSON.parse(body);

  // Process different message types
  switch (payload.type) {
    case 'text':
      await processTextMessage(payload);
      break;

    case 'interactive':
      await processInteractiveResponse(payload);
      break;

    case 'typing':
      await processTypingIndicator(payload);
      break;

    case 'close':
      await processConversationClose(payload);
      break;

    default:
      console.log('Unknown message type:', payload.type);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true }),
  };
}

/**
 * Handle EventBridge events
 */
async function handleEventBridgeEvent(event: any): Promise<any> {
  const { detail, 'detail-type': detailType } = event;

  switch (detailType) {
    case 'SendAppleMessage':
      return sendMessage(detail);

    default:
      console.log('Unhandled event type:', detailType);
      return { handled: false };
  }
}

/**
 * Process inbound text message
 */
async function processTextMessage(message: AppleMessage): Promise<any> {
  await logMessage({
    messageId: message.id,
    sourceId: message.sourceId,
    direction: 'INBOUND',
    content: message.body,
    channel: 'apple_business',
    status: 'received',
  });

  // Route through channel router
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'routeInbound',
    channel: 'apple_business',
    direction: 'INBOUND',
    phoneNumber: message.sourceId,
    content: message.body,
    metadata: {
      appleMessageId: message.id,
      capabilities: message.capabilities,
    },
  });

  await emitEvent('AppleMessageReceived', {
    messageId: message.id,
    sourceId: message.sourceId,
    timestamp: new Date().toISOString(),
  });

  return { success: true, messageId: message.id };
}

/**
 * Process interactive response (time picker, list picker, etc.)
 */
async function processInteractiveResponse(message: AppleMessage): Promise<any> {
  const interactiveData = message.interactiveData;

  await logMessage({
    messageId: message.id,
    sourceId: message.sourceId,
    direction: 'INBOUND',
    content: JSON.stringify(interactiveData),
    channel: 'apple_business',
    status: 'received',
    messageType: 'interactive_response',
  });

  // Route through channel router with interactive data
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'routeInbound',
    channel: 'apple_business',
    direction: 'INBOUND',
    phoneNumber: message.sourceId,
    content: interactiveData.data?.selectedItem?.title || 'Interactive response',
    metadata: {
      appleMessageId: message.id,
      interactiveType: interactiveData.type,
      interactiveData: interactiveData.data,
    },
  });

  await emitEvent('AppleInteractiveResponse', {
    messageId: message.id,
    sourceId: message.sourceId,
    interactiveType: interactiveData.type,
    response: interactiveData.data,
    timestamp: new Date().toISOString(),
  });

  return { success: true, messageId: message.id };
}

/**
 * Process typing indicator
 */
async function processTypingIndicator(message: any): Promise<any> {
  await emitEvent('AppleTypingIndicator', {
    sourceId: message.sourceId,
    isTyping: message.isTyping,
    timestamp: new Date().toISOString(),
  });

  return { success: true };
}

/**
 * Process conversation close
 */
async function processConversationClose(message: any): Promise<any> {
  await emitEvent('AppleConversationClosed', {
    sourceId: message.sourceId,
    reason: message.reason,
    timestamp: new Date().toISOString(),
  });

  return { success: true };
}

/**
 * Send text message
 */
async function sendMessage(data: {
  destinationId: string;
  body: string;
  patientId?: string;
}): Promise<any> {
  const messageId = randomUUID();

  const payload = {
    id: messageId,
    sourceId: APPLE_BUSINESS_ID,
    destinationId: data.destinationId,
    type: 'text',
    body: data.body,
  };

  await sendToApple(payload);

  await logMessage({
    messageId,
    destinationId: data.destinationId,
    direction: 'OUTBOUND',
    content: data.body,
    channel: 'apple_business',
    status: 'sent',
    patientId: data.patientId,
  });

  return { success: true, messageId };
}

/**
 * Send Time Picker
 */
async function sendTimePicker(data: {
  destinationId: string;
  title: string;
  subtitle?: string;
  eventTitle: string;
  slots: Array<{ startTime: string; duration: number }>;
  patientId?: string;
}): Promise<any> {
  const messageId = randomUUID();

  const payload = {
    id: messageId,
    sourceId: APPLE_BUSINESS_ID,
    destinationId: data.destinationId,
    type: 'interactive',
    interactiveData: {
      type: 'timePicker',
      data: {
        mspVersion: '1.0',
        requestIdentifier: messageId,
        event: {
          title: data.eventTitle,
          timeslots: data.slots.map(slot => ({
            startTime: slot.startTime,
            duration: slot.duration,
          })),
        },
        receivedMessage: {
          title: data.title,
          subtitle: data.subtitle || 'Select a convenient time',
        },
      },
    },
  };

  await sendToApple(payload);

  await logMessage({
    messageId,
    destinationId: data.destinationId,
    direction: 'OUTBOUND',
    content: `Time Picker: ${data.title}`,
    channel: 'apple_business',
    status: 'sent',
    messageType: 'time_picker',
    patientId: data.patientId,
  });

  return { success: true, messageId };
}

/**
 * Send List Picker
 */
async function sendListPicker(data: {
  destinationId: string;
  title: string;
  subtitle?: string;
  sections: Array<{
    title: string;
    items: Array<{ id: string; title: string; subtitle?: string; image?: string }>;
  }>;
  patientId?: string;
}): Promise<any> {
  const messageId = randomUUID();

  const payload = {
    id: messageId,
    sourceId: APPLE_BUSINESS_ID,
    destinationId: data.destinationId,
    type: 'interactive',
    interactiveData: {
      type: 'listPicker',
      data: {
        mspVersion: '1.0',
        requestIdentifier: messageId,
        listPicker: {
          sections: data.sections.map(section => ({
            title: section.title,
            items: section.items.map(item => ({
              identifier: item.id,
              title: item.title,
              subtitle: item.subtitle,
              image: item.image,
            })),
          })),
        },
        receivedMessage: {
          title: data.title,
          subtitle: data.subtitle || 'Choose an option',
        },
      },
    },
  };

  await sendToApple(payload);

  await logMessage({
    messageId,
    destinationId: data.destinationId,
    direction: 'OUTBOUND',
    content: `List Picker: ${data.title}`,
    channel: 'apple_business',
    status: 'sent',
    messageType: 'list_picker',
    patientId: data.patientId,
  });

  return { success: true, messageId };
}

/**
 * Send Rich Link
 */
async function sendRichLink(data: {
  destinationId: string;
  title: string;
  url: string;
  imageUrl?: string;
  patientId?: string;
}): Promise<any> {
  const messageId = randomUUID();

  const payload = {
    id: messageId,
    sourceId: APPLE_BUSINESS_ID,
    destinationId: data.destinationId,
    type: 'interactive',
    interactiveData: {
      type: 'richLink',
      data: {
        url: data.url,
        title: data.title,
        image: data.imageUrl,
      },
    },
  };

  await sendToApple(payload);

  await logMessage({
    messageId,
    destinationId: data.destinationId,
    direction: 'OUTBOUND',
    content: `Rich Link: ${data.title} - ${data.url}`,
    channel: 'apple_business',
    status: 'sent',
    messageType: 'rich_link',
    patientId: data.patientId,
  });

  return { success: true, messageId };
}

/**
 * Send Quick Replies
 */
async function sendQuickReplies(data: {
  destinationId: string;
  title: string;
  replies: Array<{ id: string; title: string }>;
  patientId?: string;
}): Promise<any> {
  const messageId = randomUUID();

  const payload = {
    id: messageId,
    sourceId: APPLE_BUSINESS_ID,
    destinationId: data.destinationId,
    type: 'interactive',
    interactiveData: {
      type: 'quickReply',
      data: {
        mspVersion: '1.0',
        requestIdentifier: messageId,
        receivedMessage: {
          title: data.title,
        },
        replyMessage: {
          buttons: data.replies.map(reply => ({
            identifier: reply.id,
            title: reply.title,
          })),
        },
      },
    },
  };

  await sendToApple(payload);

  await logMessage({
    messageId,
    destinationId: data.destinationId,
    direction: 'OUTBOUND',
    content: `Quick Replies: ${data.title}`,
    channel: 'apple_business',
    status: 'sent',
    messageType: 'quick_replies',
    patientId: data.patientId,
  });

  return { success: true, messageId };
}

/**
 * Send typing indicator
 */
async function sendTypingIndicator(data: {
  destinationId: string;
  isTyping: boolean;
}): Promise<any> {
  const payload = {
    sourceId: APPLE_BUSINESS_ID,
    destinationId: data.destinationId,
    type: 'typing',
    isTyping: data.isTyping,
  };

  await sendToApple(payload);

  return { success: true };
}

/**
 * Close conversation
 */
async function closeConversation(data: {
  destinationId: string;
  reason?: string;
}): Promise<any> {
  const payload = {
    sourceId: APPLE_BUSINESS_ID,
    destinationId: data.destinationId,
    type: 'close',
    reason: data.reason || 'Agent closed conversation',
  };

  await sendToApple(payload);

  await emitEvent('AppleConversationClosed', {
    destinationId: data.destinationId,
    reason: data.reason,
    closedBy: 'agent',
    timestamp: new Date().toISOString(),
  });

  return { success: true };
}

// Helper functions
async function getAppleSecrets(): Promise<{ apiKey: string; secret: string }> {
  const response = await secretsManager.send(new GetSecretValueCommand({
    SecretId: APPLE_SECRETS_ARN,
  }));
  return JSON.parse(response.SecretString || '{}');
}

async function sendToApple(payload: any): Promise<void> {
  const secrets = await getAppleSecrets();

  // In production, this would make an HTTPS request to Apple's API
  console.log('Sending to Apple:', JSON.stringify(payload, null, 2));

  // Emit event for any listeners
  await emitEvent('AppleMessageSent', {
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

async function verifySignature(body: string, signature: string): Promise<boolean> {
  if (!signature) return false;

  try {
    const secrets = await getAppleSecrets();
    const expectedSignature = crypto
      .createHmac('sha256', secrets.secret)
      .update(body)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

async function logMessage(data: any): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: MESSAGE_LOG_TABLE,
    Item: {
      ...data,
      timestamp: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60),
    },
  }));
}

async function invokeFunction(functionArn: string, payload: any): Promise<any> {
  const command = new InvokeCommand({
    FunctionName: functionArn,
    Payload: JSON.stringify(payload),
    InvocationType: 'Event',
  });
  await lambdaClient.send(command);
}

async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [{
      EventBusName: EVENT_BUS_NAME,
      Source: 'medcx.apple',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
