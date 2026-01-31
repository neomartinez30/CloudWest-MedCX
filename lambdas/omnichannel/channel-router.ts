import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PinpointClient, SendMessagesCommand } from '@aws-sdk/client-pinpoint';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const pinpointClient = new PinpointClient({});
const snsClient = new SNSClient({});
const eventBridge = new EventBridgeClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const PINPOINT_APP_ID = process.env.PINPOINT_APP_ID!;
const IDENTITY_RESOLVER_ARN = process.env.IDENTITY_RESOLVER_ARN!;
const CONVERSATION_MANAGER_ARN = process.env.CONVERSATION_MANAGER_ARN!;

type Channel = 'voice' | 'sms' | 'apple_messages' | 'web_chat';

interface ChannelMessage {
  channel: Channel;
  direction: 'inbound' | 'outbound';
  phoneNumber?: string;
  patientId?: string;
  content: string;
  messageType?: string;
  metadata?: Record<string, any>;
}

interface InteractiveMessage {
  type: 'time_picker' | 'list_picker' | 'rich_link' | 'quick_replies';
  payload: any;
}

/**
 * Channel Router Lambda
 *
 * Central routing hub for all omnichannel communications:
 * - Routes messages between voice, SMS, Apple Messages, and web chat
 * - Maintains unified conversation context across channels
 * - Resolves patient identity from any channel
 * - Supports channel handoffs (e.g., voice to SMS)
 * - Handles interactive messages for rich channels
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Channel Router Event:', JSON.stringify(event, null, 2));

  try {
    // Handle EventBridge events
    if (event.source?.startsWith('medcx')) {
      return handleEventBridgeEvent(event);
    }

    // Handle direct invocations
    const { action, ...data } = event;

    switch (action) {
      case 'routeInbound':
        return routeInboundMessage(data);

      case 'sendOutbound':
        return sendOutboundMessage(data);

      case 'handoffChannel':
        return handoffToChannel(data);

      case 'sendInteractive':
        return sendInteractiveMessage(data);

      case 'getConversationContext':
        return getConversationContext(data.patientId);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in channel router:', error);
    return {
      error: 'Failed to route message',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

async function handleEventBridgeEvent(event: any): Promise<any> {
  const { detail, 'detail-type': detailType } = event;

  switch (detailType) {
    case 'IncomingMessage':
      return routeInboundMessage(detail);

    case 'ChannelHandoffRequested':
      return handoffToChannel(detail);

    default:
      console.log('Unhandled event type:', detailType);
      return { handled: false };
  }
}

async function routeInboundMessage(data: ChannelMessage): Promise<any> {
  const { channel, phoneNumber, content, metadata } = data;
  const now = new Date().toISOString();

  // Resolve patient identity
  let patientId = data.patientId;
  if (!patientId && phoneNumber) {
    const identity = await resolveIdentity(phoneNumber, channel);
    patientId = identity?.patientId;

    if (!patientId) {
      const newIdentity = await resolveIdentity(phoneNumber, channel, true);
      patientId = newIdentity?.patientId;
    }
  }

  if (!patientId) {
    return { error: 'Could not resolve patient identity' };
  }

  // Get or create conversation thread
  const conversationResult = await invokeFunction(CONVERSATION_MANAGER_ARN, {
    action: 'getOrCreateThread',
    patientId,
    channel,
  });

  const threadId = conversationResult.threadId;

  // Store the message
  await invokeFunction(CONVERSATION_MANAGER_ARN, {
    action: 'addMessage',
    threadId,
    patientId,
    message: {
      content,
      channel,
      direction: 'inbound',
      messageType: 'text',
      metadata,
    },
  });

  // Record interaction
  await recordInteraction(patientId, {
    channel,
    direction: 'inbound',
    type: 'message',
    threadId,
  });

  // Emit event for downstream processing
  await emitEvent('MessageRouted', {
    patientId,
    threadId,
    channel,
    direction: 'inbound',
    content,
    timestamp: now,
  });

  return {
    success: true,
    patientId,
    threadId,
    channel,
  };
}

async function sendOutboundMessage(data: ChannelMessage): Promise<any> {
  const { channel, patientId, content, phoneNumber, messageType = 'text' } = data;

  let targetPhone = phoneNumber;
  if (!targetPhone && patientId) {
    const patient = await getPatient(patientId);
    targetPhone = patient?.phoneNumber;
  }

  if (!targetPhone) {
    return { error: 'No phone number available' };
  }

  let result;
  switch (channel) {
    case 'sms':
      result = await sendSMS(targetPhone, content);
      break;

    case 'apple_messages':
      result = await sendAppleMessage(targetPhone, content);
      break;

    case 'voice':
      result = { success: true, message: 'Voice message queued' };
      break;

    default:
      result = await sendSMS(targetPhone, content);
  }

  if (patientId) {
    const conversationResult = await invokeFunction(CONVERSATION_MANAGER_ARN, {
      action: 'getOrCreateThread',
      patientId,
      channel,
    });

    await invokeFunction(CONVERSATION_MANAGER_ARN, {
      action: 'addMessage',
      threadId: conversationResult.threadId,
      patientId,
      message: {
        content,
        channel,
        direction: 'outbound',
        messageType,
      },
    });

    await recordInteraction(patientId, {
      channel,
      direction: 'outbound',
      type: 'message',
      threadId: conversationResult.threadId,
    });
  }

  return result;
}

async function handoffToChannel(data: {
  patientId: string;
  fromChannel: Channel;
  toChannel: Channel;
  message?: string;
}): Promise<any> {
  const { patientId, fromChannel, toChannel, message } = data;

  await invokeFunction(CONVERSATION_MANAGER_ARN, {
    action: 'handoffChannel',
    patientId,
    fromChannel,
    toChannel,
    handoffMessage: message,
  });

  if (message) {
    await sendOutboundMessage({
      channel: toChannel,
      patientId,
      content: message,
      direction: 'outbound',
    });
  }

  await emitEvent('ChannelHandoffCompleted', {
    patientId,
    fromChannel,
    toChannel,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    patientId,
    newChannel: toChannel,
  };
}

async function sendInteractiveMessage(data: {
  patientId: string;
  interactiveType: InteractiveMessage['type'];
  payload: any;
}): Promise<any> {
  const { patientId, interactiveType, payload } = data;

  const patient = await getPatient(patientId);
  if (!patient?.phoneNumber) {
    return { error: 'Patient phone number not found' };
  }

  let interactivePayload;
  switch (interactiveType) {
    case 'time_picker':
      interactivePayload = buildTimePicker(payload);
      break;

    case 'list_picker':
      interactivePayload = buildListPicker(payload);
      break;

    case 'rich_link':
      interactivePayload = buildRichLink(payload);
      break;

    case 'quick_replies':
      interactivePayload = buildQuickReplies(payload);
      break;

    default:
      return { error: 'Unknown interactive message type' };
  }

  await invokeFunction(CONVERSATION_MANAGER_ARN, {
    action: 'sendInteractiveMessage',
    threadId: `thread-${patientId}`,
    patientId,
    messageType: interactiveType,
    payload: interactivePayload,
  });

  return {
    success: true,
    interactiveType,
    patientId,
  };
}

async function getConversationContext(patientId: string): Promise<any> {
  const [patient, recentMessages, recentInteractions] = await Promise.all([
    getPatient(patientId),
    getRecentMessages(patientId),
    getRecentInteractions(patientId),
  ]);

  const channelHistory = new Set<string>();
  recentInteractions.forEach((i: any) => {
    if (i.channel) channelHistory.add(i.channel);
  });

  return {
    patientId,
    patient: {
      name: `${patient?.firstName || ''} ${patient?.lastName || ''}`.trim(),
      preferredChannel: patient?.preferredChannel || 'sms',
      phoneNumber: patient?.phoneNumber,
    },
    recentMessages: recentMessages.slice(0, 10),
    channelHistory: Array.from(channelHistory),
    lastInteraction: recentInteractions[0]?.interactionTimestamp,
  };
}

async function sendSMS(phoneNumber: string, message: string): Promise<any> {
  const command = new SendMessagesCommand({
    ApplicationId: PINPOINT_APP_ID,
    MessageRequest: {
      Addresses: {
        [phoneNumber]: {
          ChannelType: 'SMS',
        },
      },
      MessageConfiguration: {
        SMSMessage: {
          Body: message,
          MessageType: 'TRANSACTIONAL',
        },
      },
    },
  });

  const response = await pinpointClient.send(command);
  const result = response.MessageResponse?.Result?.[phoneNumber];

  return {
    success: result?.StatusCode === 200,
    messageId: result?.MessageId,
    channel: 'sms',
  };
}

async function sendAppleMessage(phoneNumber: string, message: string, interactive?: any): Promise<any> {
  await emitEvent('SendAppleMessage', {
    destinationId: phoneNumber,
    body: message,
    interactiveData: interactive,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    channel: 'apple_messages',
  };
}

function buildTimePicker(payload: any): any {
  return {
    type: 'interactive',
    interactive: {
      type: 'timePicker',
      header: { type: 'text', text: payload.title || 'Select a Time' },
      body: { text: payload.subtitle || 'Choose an available time slot' },
      action: {
        event: {
          title: payload.eventTitle || 'Appointment',
          timeslots: payload.slots?.map((slot: any) => ({
            startTime: slot.startTime,
            duration: slot.duration || 30,
          })) || [],
        },
      },
    },
  };
}

function buildListPicker(payload: any): any {
  return {
    type: 'interactive',
    interactive: {
      type: 'listPicker',
      header: { type: 'text', text: payload.title || 'Select an Option' },
      body: { text: payload.subtitle || 'Choose from the options below' },
      action: {
        sections: payload.sections?.map((section: any) => ({
          title: section.title,
          items: section.items?.map((item: any) => ({
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
          })),
        })) || [],
      },
    },
  };
}

function buildRichLink(payload: any): any {
  return {
    type: 'interactive',
    interactive: {
      type: 'richLink',
      url: payload.url,
      title: payload.title,
      image: payload.imageUrl,
    },
  };
}

function buildQuickReplies(payload: any): any {
  return {
    type: 'interactive',
    interactive: {
      type: 'quickReply',
      header: { type: 'text', text: payload.title },
      action: {
        buttons: payload.replies?.map((reply: any) => ({
          type: 'reply',
          reply: { id: reply.id, title: reply.title },
        })),
      },
    },
  };
}

async function resolveIdentity(phoneNumber: string, channel: string, createIfNotFound = false): Promise<any> {
  return invokeFunction(IDENTITY_RESOLVER_ARN, {
    phoneNumber,
    channel,
    createIfNotFound,
  });
}

async function getPatient(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));
  return result.Item;
}

async function getRecentMessages(patientId: string): Promise<any[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
    Limit: 20,
  }));
  return result.Items || [];
}

async function getRecentInteractions(patientId: string): Promise<any[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: INTERACTION_TABLE,
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
    Limit: 20,
  }));
  return result.Items || [];
}

async function recordInteraction(patientId: string, data: any): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: INTERACTION_TABLE,
    Item: {
      patientId,
      interactionTimestamp: new Date().toISOString(),
      interactionId: randomUUID(),
      ...data,
    },
  }));
}

async function invokeFunction(functionArn: string, payload: any): Promise<any> {
  const command = new InvokeCommand({
    FunctionName: functionArn,
    Payload: JSON.stringify(payload),
  });
  const response = await lambdaClient.send(command);
  return JSON.parse(new TextDecoder().decode(response.Payload));
}

async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [{
      EventBusName: EVENT_BUS_NAME,
      Source: 'medcx.channels',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
