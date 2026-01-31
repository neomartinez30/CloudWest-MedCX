import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';

const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});

const HANDOFF_TABLE = process.env.HANDOFF_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const SMS_HANDLER_ARN = process.env.SMS_HANDLER_ARN!;
const APPLE_HANDLER_ARN = process.env.APPLE_HANDLER_ARN!;
const VOICE_HANDLER_ARN = process.env.VOICE_HANDLER_ARN!;
const CONVERSATION_MANAGER_ARN = process.env.CONVERSATION_MANAGER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

type Channel = 'voice' | 'sms' | 'apple_messages' | 'web_chat';

interface HandoffRequest {
  patientId: string;
  fromChannel: Channel;
  toChannel: Channel;
  message?: string;
  context?: Record<string, any>;
  reason?: string;
}

interface HandoffRecord {
  handoffId: string;
  patientId: string;
  fromChannel: Channel;
  toChannel: Channel;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  message?: string;
  context?: Record<string, any>;
  reason?: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * Channel Handoff Lambda
 *
 * Manages seamless channel transitions:
 * - Voice to SMS handoff (most common)
 * - SMS to Apple Messages upgrade
 * - Any channel to any channel with context preservation
 * - Automatic conversation merging
 * - Handoff tracking and analytics
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Channel Handoff Event:', JSON.stringify(event, null, 2));

  try {
    // Handle EventBridge events
    if (event.source?.startsWith('medcx')) {
      return handleEventBridgeEvent(event);
    }

    // Handle direct invocations
    const { action, ...data } = event;

    switch (action) {
      case 'initiateHandoff':
        return initiateHandoff(data);

      case 'completeHandoff':
        return completeHandoff(data);

      case 'cancelHandoff':
        return cancelHandoff(data);

      case 'getHandoffStatus':
        return getHandoffStatus(data.handoffId);

      case 'getPatientHandoffs':
        return getPatientHandoffs(data.patientId);

      case 'suggestHandoff':
        return suggestHandoff(data);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in channel handoff:', error);
    return {
      error: 'Handoff failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Handle EventBridge events
 */
async function handleEventBridgeEvent(event: any): Promise<any> {
  const { detail, 'detail-type': detailType } = event;

  switch (detailType) {
    case 'ChannelHandoffRequested':
      return initiateHandoff(detail);

    case 'HandoffMessageDelivered':
      return completeHandoff({
        handoffId: detail.handoffId,
        success: true,
      });

    default:
      console.log('Unhandled event type:', detailType);
      return { handled: false };
  }
}

/**
 * Initiate channel handoff
 */
async function initiateHandoff(request: HandoffRequest): Promise<any> {
  const { patientId, fromChannel, toChannel, message, context, reason } = request;
  const handoffId = uuidv4();
  const now = new Date().toISOString();

  // Create handoff record
  const handoffRecord: HandoffRecord = {
    handoffId,
    patientId,
    fromChannel,
    toChannel,
    status: 'in_progress',
    message,
    context,
    reason,
    createdAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: HANDOFF_TABLE,
    Item: handoffRecord,
  }));

  // Get conversation context from source channel
  const conversationContext = await getConversationContext(patientId, fromChannel);

  // Merge context for destination channel
  const mergedContext = {
    ...conversationContext,
    ...context,
    handoffFrom: fromChannel,
    handoffId,
    handoffReason: reason,
  };

  // Update conversation manager with handoff
  await invokeFunction(CONVERSATION_MANAGER_ARN, {
    action: 'recordHandoff',
    patientId,
    fromChannel,
    toChannel,
    handoffId,
    context: mergedContext,
  });

  // Send handoff message to destination channel
  const handoffMessage = message || getDefaultHandoffMessage(fromChannel, toChannel);

  const sendResult = await sendToChannel(toChannel, {
    patientId,
    message: handoffMessage,
    context: mergedContext,
  });

  if (sendResult.success) {
    await updateHandoffStatus(handoffId, 'completed', now);

    await emitEvent('ChannelHandoffCompleted', {
      handoffId,
      patientId,
      fromChannel,
      toChannel,
      timestamp: now,
    });

    return {
      success: true,
      handoffId,
      fromChannel,
      toChannel,
      messageDelivered: true,
    };
  } else {
    await updateHandoffStatus(handoffId, 'failed');

    await emitEvent('ChannelHandoffFailed', {
      handoffId,
      patientId,
      fromChannel,
      toChannel,
      error: sendResult.error,
      timestamp: now,
    });

    return {
      success: false,
      handoffId,
      error: sendResult.error,
    };
  }
}

/**
 * Complete handoff
 */
async function completeHandoff(data: {
  handoffId: string;
  success: boolean;
  error?: string;
}): Promise<any> {
  const status = data.success ? 'completed' : 'failed';
  await updateHandoffStatus(data.handoffId, status);

  return {
    success: true,
    handoffId: data.handoffId,
    status,
  };
}

/**
 * Cancel handoff
 */
async function cancelHandoff(data: { handoffId: string; reason?: string }): Promise<any> {
  const handoff = await getHandoffStatus(data.handoffId);

  if (!handoff) {
    return { error: 'Handoff not found' };
  }

  if (handoff.status === 'completed') {
    return { error: 'Cannot cancel completed handoff' };
  }

  await docClient.send(new UpdateCommand({
    TableName: HANDOFF_TABLE,
    Key: { handoffId: data.handoffId },
    UpdateExpression: 'SET #status = :status, cancelReason = :reason, cancelledAt = :time',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'cancelled',
      ':reason': data.reason,
      ':time': new Date().toISOString(),
    },
  }));

  await emitEvent('ChannelHandoffCancelled', {
    handoffId: data.handoffId,
    reason: data.reason,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    handoffId: data.handoffId,
    status: 'cancelled',
  };
}

/**
 * Get handoff status
 */
async function getHandoffStatus(handoffId: string): Promise<HandoffRecord | null> {
  const result = await docClient.send(new GetCommand({
    TableName: HANDOFF_TABLE,
    Key: { handoffId },
  }));

  return result.Item as HandoffRecord || null;
}

/**
 * Get patient handoffs
 */
async function getPatientHandoffs(patientId: string): Promise<HandoffRecord[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: HANDOFF_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
    Limit: 20,
  }));

  return (result.Items || []) as HandoffRecord[];
}

/**
 * Suggest handoff based on context
 */
async function suggestHandoff(data: {
  patientId: string;
  currentChannel: Channel;
  conversationContext?: any;
}): Promise<any> {
  const { patientId, currentChannel, conversationContext } = data;

  const suggestions: Array<{
    toChannel: Channel;
    reason: string;
    priority: number;
  }> = [];

  // Voice to SMS is common for follow-ups
  if (currentChannel === 'voice') {
    suggestions.push({
      toChannel: 'sms',
      reason: 'Continue conversation via text for convenience',
      priority: 1,
    });
  }

  // SMS to Apple Messages for rich interactions
  if (currentChannel === 'sms') {
    const patientCapabilities = conversationContext?.capabilities || [];
    if (patientCapabilities.includes('apple_messages')) {
      suggestions.push({
        toChannel: 'apple_messages',
        reason: 'Upgrade to rich messaging for appointment scheduling',
        priority: 1,
      });
    }
  }

  // If scheduling appointment, suggest Apple Messages for Time Picker
  if (conversationContext?.intent === 'schedule_appointment') {
    suggestions.push({
      toChannel: 'apple_messages',
      reason: 'Use interactive Time Picker for easier scheduling',
      priority: 2,
    });
  }

  return {
    patientId,
    currentChannel,
    suggestions: suggestions.sort((a, b) => b.priority - a.priority),
  };
}

// Helper functions
async function getConversationContext(patientId: string, channel: Channel): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    KeyConditionExpression: 'patientId = :patientId',
    FilterExpression: 'channel = :channel',
    ExpressionAttributeValues: {
      ':patientId': patientId,
      ':channel': channel,
    },
    ScanIndexForward: false,
    Limit: 10,
  }));

  const messages = result.Items || [];

  return {
    recentMessages: messages.slice(0, 5),
    lastMessage: messages[0],
    messageCount: messages.length,
    channel,
  };
}

async function sendToChannel(channel: Channel, data: {
  patientId: string;
  message: string;
  context?: any;
}): Promise<{ success: boolean; error?: string }> {
  try {
    let handlerArn: string;

    switch (channel) {
      case 'sms':
        handlerArn = SMS_HANDLER_ARN;
        break;
      case 'apple_messages':
        handlerArn = APPLE_HANDLER_ARN;
        break;
      case 'voice':
        handlerArn = VOICE_HANDLER_ARN;
        break;
      default:
        handlerArn = SMS_HANDLER_ARN;
    }

    await invokeFunction(handlerArn, {
      action: channel === 'sms' ? 'send' : 'sendMessage',
      patientId: data.patientId,
      message: data.message,
      body: data.message,
      metadata: {
        isHandoff: true,
        context: data.context,
      },
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function getDefaultHandoffMessage(fromChannel: Channel, toChannel: Channel): string {
  const messages: Record<string, Record<string, string>> = {
    voice: {
      sms: "Thank you for calling! We'll continue our conversation here via text. How can I help you?",
      apple_messages: "Thank you for calling! We'll continue our conversation here. How can I help you?",
    },
    sms: {
      apple_messages: "We've upgraded you to our rich messaging experience for better service!",
      voice: "An agent will call you shortly to continue our conversation.",
    },
    apple_messages: {
      sms: "We're continuing our conversation via SMS.",
      voice: "An agent will call you shortly to continue our conversation.",
    },
  };

  return messages[fromChannel]?.[toChannel] ||
    `We're continuing our conversation on ${toChannel.replace('_', ' ')}.`;
}

async function updateHandoffStatus(
  handoffId: string,
  status: HandoffRecord['status'],
  completedAt?: string
): Promise<void> {
  const updateExpression = completedAt
    ? 'SET #status = :status, completedAt = :completedAt'
    : 'SET #status = :status';

  const expressionValues: any = { ':status': status };
  if (completedAt) {
    expressionValues[':completedAt'] = completedAt;
  }

  await docClient.send(new UpdateCommand({
    TableName: HANDOFF_TABLE,
    Key: { handoffId },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: expressionValues,
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
      Source: 'medcx.handoff',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
