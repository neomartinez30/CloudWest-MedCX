import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

/**
 * Supported communication channels
 */
type Channel = 'sms' | 'apple_business' | 'voice' | 'email' | 'web_chat';

/**
 * Message direction
 */
type Direction = 'INBOUND' | 'OUTBOUND';

/**
 * Conversation status
 */
type ConversationStatus = 'ACTIVE' | 'WAITING' | 'RESOLVED' | 'ESCALATED' | 'ARCHIVED';

/**
 * Message interface
 */
interface Message {
  messageId: string;
  threadId: string;
  patientId: string;
  channel: Channel;
  direction: Direction;
  content: string;
  contentType?: 'text' | 'image' | 'document' | 'interactive';
  interactiveData?: InteractiveMessage;
  metadata?: Record<string, any>;
  agentId?: string;
  botHandled?: boolean;
  sentiment?: string;
  intent?: string;
  status: 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  createdAt: string;
}

/**
 * Interactive message for Apple Messages for Business
 */
interface InteractiveMessage {
  type: 'listPicker' | 'timePicker' | 'richLink' | 'quickReply';
  data: any;
  response?: any;
}

/**
 * Conversation thread
 */
interface ConversationThread {
  threadId: string;
  patientId: string;
  channel: Channel;
  status: ConversationStatus;
  subject?: string;
  category?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  assignedTo?: string;
  lastMessageAt: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  handoffHistory?: ChannelHandoff[];
}

/**
 * Channel handoff record
 */
interface ChannelHandoff {
  fromChannel: Channel;
  toChannel: Channel;
  reason: string;
  timestamp: string;
  initiatedBy: 'patient' | 'agent' | 'system';
}

/**
 * Conversation Manager Lambda Handler
 *
 * This function provides unified conversation management across all channels:
 * - SMS via Amazon Pinpoint
 * - Apple Messages for Business
 * - Voice via Amazon Connect
 * - Email
 * - Web chat
 *
 * Key features:
 * - Unified conversation threads across channels
 * - Channel handoff support (e.g., SMS to voice)
 * - Real-time status tracking
 * - Integration with identity resolver for patient context
 * - Support for interactive messaging (Apple Messages)
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Conversation Manager Event:', JSON.stringify(event, null, 2));

  try {
    // Handle EventBridge events
    if (event.source?.startsWith('medcx.')) {
      return handleEventBridgeEvent(event);
    }

    // Handle API Gateway requests
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const path = event.path || event.rawPath;
    const pathParameters = event.pathParameters || {};

    // Route based on path and method
    if (path?.includes('/messages')) {
      if (httpMethod === 'POST') {
        return addMessage(pathParameters.threadId, JSON.parse(event.body || '{}'));
      }
    }

    switch (httpMethod) {
      case 'POST':
        return createConversation(JSON.parse(event.body || '{}'));
      case 'GET':
        if (pathParameters.threadId) {
          return getConversation(pathParameters.threadId);
        }
        return listConversations(event.queryStringParameters || {});
      case 'PUT':
        return updateConversation(pathParameters.threadId, JSON.parse(event.body || '{}'));
      default:
        return formatResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error in Conversation Manager:', error);
    return formatResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Handle EventBridge events for conversation lifecycle
 */
async function handleEventBridgeEvent(event: any): Promise<any> {
  const source = event.source;
  const detailType = event['detail-type'];
  const detail = event.detail;

  switch (detailType) {
    case 'InboundMessage':
      return handleInboundMessage(detail);
    case 'OutboundMessageSent':
      return handleOutboundMessageStatus(detail, 'SENT');
    case 'MessageDelivered':
      return handleOutboundMessageStatus(detail, 'DELIVERED');
    case 'MessageRead':
      return handleOutboundMessageStatus(detail, 'READ');
    case 'ChannelHandoffRequested':
      return handleChannelHandoff(detail);
    case 'ConversationEscalated':
      return handleEscalation(detail);
    default:
      console.log('Unhandled event type:', detailType);
      return { statusCode: 200, body: 'Event acknowledged' };
  }
}

/**
 * Create a new conversation thread
 */
async function createConversation(data: {
  patientId: string;
  channel: Channel;
  initialMessage?: string;
  subject?: string;
  category?: string;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { patientId, channel, initialMessage, subject, category, metadata } = data;

  // Check if patient exists
  const patientExists = await verifyPatient(patientId);
  if (!patientExists) {
    return formatResponse(404, { error: 'Patient not found' });
  }

  const threadId = uuidv4();
  const now = new Date().toISOString();

  const thread: ConversationThread = {
    threadId,
    patientId,
    channel,
    status: 'ACTIVE',
    subject: subject || 'New conversation',
    category,
    priority: 'normal',
    lastMessageAt: now,
    messageCount: initialMessage ? 1 : 0,
    createdAt: now,
    updatedAt: now,
    handoffHistory: [],
  };

  // Store thread metadata
  await docClient.send(new PutCommand({
    TableName: CONVERSATION_TABLE,
    Item: {
      patientId,
      messageTimestamp: `THREAD#${threadId}`,
      ...thread,
      ttl: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60), // 1 year TTL
    },
  }));

  // If there's an initial message, add it
  if (initialMessage) {
    await addMessageToThread(threadId, patientId, {
      content: initialMessage,
      channel,
      direction: 'INBOUND',
      metadata,
    });
  }

  // Emit conversation created event
  await emitEvent('ConversationCreated', {
    threadId,
    patientId,
    channel,
    timestamp: now,
  });

  return formatResponse(201, thread);
}

/**
 * Get conversation by thread ID
 */
async function getConversation(threadId: string): Promise<any> {
  // Get thread by querying the thread index
  const threadResult = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    IndexName: 'thread-index',
    KeyConditionExpression: 'threadId = :threadId',
    ExpressionAttributeValues: {
      ':threadId': threadId,
    },
    ScanIndexForward: true, // Oldest first for messages
  }));

  if (!threadResult.Items || threadResult.Items.length === 0) {
    return formatResponse(404, { error: 'Conversation not found' });
  }

  // Separate thread metadata from messages
  const items = threadResult.Items;
  const threadMeta = items.find(i => i.messageTimestamp?.startsWith('THREAD#'));
  const messages = items.filter(i => !i.messageTimestamp?.startsWith('THREAD#'));

  return formatResponse(200, {
    thread: threadMeta,
    messages,
  });
}

/**
 * List conversations with filters
 */
async function listConversations(queryParams: any): Promise<any> {
  const { patientId, status, channel, limit = 20 } = queryParams;

  if (!patientId && !status) {
    return formatResponse(400, { error: 'patientId or status query parameter is required' });
  }

  let result;

  if (patientId) {
    // Query by patient
    result = await docClient.send(new QueryCommand({
      TableName: CONVERSATION_TABLE,
      KeyConditionExpression: 'patientId = :patientId AND begins_with(messageTimestamp, :prefix)',
      ExpressionAttributeValues: {
        ':patientId': patientId,
        ':prefix': 'THREAD#',
      },
      ScanIndexForward: false,
      Limit: parseInt(limit),
    }));
  } else {
    // Query by status using GSI
    result = await docClient.send(new QueryCommand({
      TableName: CONVERSATION_TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': status,
      },
      ScanIndexForward: false,
      Limit: parseInt(limit),
    }));
  }

  // Filter by channel if specified
  let threads = result.Items || [];
  if (channel) {
    threads = threads.filter(t => t.channel === channel);
  }

  return formatResponse(200, { conversations: threads });
}

/**
 * Update conversation status or assignment
 */
async function updateConversation(threadId: string, updates: {
  status?: ConversationStatus;
  assignedTo?: string;
  priority?: string;
  category?: string;
}): Promise<any> {
  if (!threadId) {
    return formatResponse(400, { error: 'Thread ID is required' });
  }

  // First, find the thread to get patientId
  const threadResult = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    IndexName: 'thread-index',
    KeyConditionExpression: 'threadId = :threadId',
    FilterExpression: 'begins_with(messageTimestamp, :prefix)',
    ExpressionAttributeValues: {
      ':threadId': threadId,
      ':prefix': 'THREAD#',
    },
    Limit: 1,
  }));

  if (!threadResult.Items || threadResult.Items.length === 0) {
    return formatResponse(404, { error: 'Conversation not found' });
  }

  const thread = threadResult.Items[0];
  const now = new Date().toISOString();

  // Build update expression
  const updateExpressions: string[] = ['updatedAt = :updatedAt'];
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': now,
  };

  if (updates.status) {
    updateExpressions.push('#status = :status');
    expressionAttributeValues[':status'] = updates.status;

    if (updates.status === 'RESOLVED') {
      updateExpressions.push('resolvedAt = :resolvedAt');
      expressionAttributeValues[':resolvedAt'] = now;
    }
  }

  if (updates.assignedTo) {
    updateExpressions.push('assignedTo = :assignedTo');
    expressionAttributeValues[':assignedTo'] = updates.assignedTo;
  }

  if (updates.priority) {
    updateExpressions.push('priority = :priority');
    expressionAttributeValues[':priority'] = updates.priority;
  }

  if (updates.category) {
    updateExpressions.push('category = :category');
    expressionAttributeValues[':category'] = updates.category;
  }

  const result = await docClient.send(new UpdateCommand({
    TableName: CONVERSATION_TABLE,
    Key: {
      patientId: thread.patientId,
      messageTimestamp: `THREAD#${threadId}`,
    },
    UpdateExpression: 'SET ' + updateExpressions.join(', '),
    ExpressionAttributeValues: expressionAttributeValues,
    ExpressionAttributeNames: updates.status ? { '#status': 'status' } : undefined,
    ReturnValues: 'ALL_NEW',
  }));

  // Emit status change event
  if (updates.status) {
    await emitEvent('ConversationStatusChanged', {
      threadId,
      patientId: thread.patientId,
      oldStatus: thread.status,
      newStatus: updates.status,
      timestamp: now,
    });
  }

  return formatResponse(200, result.Attributes);
}

/**
 * Add a message to a conversation
 */
async function addMessage(threadId: string, messageData: {
  content: string;
  channel: Channel;
  direction: Direction;
  contentType?: string;
  interactiveData?: InteractiveMessage;
  metadata?: Record<string, any>;
  agentId?: string;
}): Promise<any> {
  if (!threadId) {
    return formatResponse(400, { error: 'Thread ID is required' });
  }

  // Get thread to verify it exists and get patientId
  const threadResult = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    IndexName: 'thread-index',
    KeyConditionExpression: 'threadId = :threadId',
    FilterExpression: 'begins_with(messageTimestamp, :prefix)',
    ExpressionAttributeValues: {
      ':threadId': threadId,
      ':prefix': 'THREAD#',
    },
    Limit: 1,
  }));

  if (!threadResult.Items || threadResult.Items.length === 0) {
    return formatResponse(404, { error: 'Conversation not found' });
  }

  const thread = threadResult.Items[0];
  const message = await addMessageToThread(threadId, thread.patientId, messageData);

  return formatResponse(201, message);
}

/**
 * Internal: Add message to thread
 */
async function addMessageToThread(
  threadId: string,
  patientId: string,
  data: {
    content: string;
    channel: Channel;
    direction: Direction;
    contentType?: string;
    interactiveData?: InteractiveMessage;
    metadata?: Record<string, any>;
    agentId?: string;
  }
): Promise<Message> {
  const messageId = uuidv4();
  const now = new Date().toISOString();

  const message: Message = {
    messageId,
    threadId,
    patientId,
    channel: data.channel,
    direction: data.direction,
    content: data.content,
    contentType: (data.contentType || 'text') as 'text' | 'image' | 'document' | 'interactive',
    interactiveData: data.interactiveData,
    metadata: data.metadata,
    agentId: data.agentId,
    status: data.direction === 'OUTBOUND' ? 'PENDING' : 'DELIVERED',
    createdAt: now,
  };

  // Store message
  await docClient.send(new PutCommand({
    TableName: CONVERSATION_TABLE,
    Item: {
      patientId,
      messageTimestamp: now,
      ...message,
      ttl: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60),
    },
  }));

  // Update thread metadata
  await docClient.send(new UpdateCommand({
    TableName: CONVERSATION_TABLE,
    Key: {
      patientId,
      messageTimestamp: `THREAD#${threadId}`,
    },
    UpdateExpression: 'SET lastMessageAt = :lastMessageAt, messageCount = messageCount + :inc, updatedAt = :updatedAt, lastUpdated = :lastUpdated',
    ExpressionAttributeValues: {
      ':lastMessageAt': now,
      ':inc': 1,
      ':updatedAt': now,
      ':lastUpdated': now,
    },
  }));

  // Emit message event
  await emitEvent(data.direction === 'INBOUND' ? 'InboundMessageReceived' : 'OutboundMessageCreated', {
    messageId,
    threadId,
    patientId,
    channel: data.channel,
    direction: data.direction,
    timestamp: now,
  });

  // Record interaction
  await recordInteraction(patientId, threadId, message);

  return message;
}

/**
 * Handle inbound message from any channel
 */
async function handleInboundMessage(detail: any): Promise<any> {
  const { patientId, channel, content, threadId, metadata } = detail;

  // If no threadId, try to find active conversation or create new one
  let actualThreadId = threadId;

  if (!actualThreadId) {
    // Look for active conversation for this patient on this channel
    const activeConvo = await findActiveConversation(patientId, channel);
    if (activeConvo) {
      actualThreadId = activeConvo.threadId;
    } else {
      // Create new conversation
      const newThread = await createConversation({
        patientId,
        channel,
        initialMessage: content,
        metadata,
      });
      return newThread;
    }
  }

  // Add message to existing thread
  await addMessageToThread(actualThreadId, patientId, {
    content,
    channel,
    direction: 'INBOUND',
    metadata,
  });

  return { statusCode: 200, body: 'Message processed' };
}

/**
 * Handle outbound message status update
 */
async function handleOutboundMessageStatus(
  detail: any,
  status: 'SENT' | 'DELIVERED' | 'READ'
): Promise<any> {
  const { messageId, patientId, messageTimestamp } = detail;

  if (!messageId || !patientId || !messageTimestamp) {
    console.log('Missing required fields for status update');
    return { statusCode: 400, body: 'Missing required fields' };
  }

  await docClient.send(new UpdateCommand({
    TableName: CONVERSATION_TABLE,
    Key: {
      patientId,
      messageTimestamp,
    },
    UpdateExpression: 'SET #status = :status, statusUpdatedAt = :statusUpdatedAt',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':status': status,
      ':statusUpdatedAt': new Date().toISOString(),
    },
  }));

  return { statusCode: 200, body: 'Status updated' };
}

/**
 * Handle channel handoff request
 */
async function handleChannelHandoff(detail: any): Promise<any> {
  const { threadId, patientId, fromChannel, toChannel, reason, initiatedBy } = detail;
  const now = new Date().toISOString();

  const handoff: ChannelHandoff = {
    fromChannel,
    toChannel,
    reason,
    timestamp: now,
    initiatedBy,
  };

  // Update thread with handoff record and new channel
  await docClient.send(new UpdateCommand({
    TableName: CONVERSATION_TABLE,
    Key: {
      patientId,
      messageTimestamp: `THREAD#${threadId}`,
    },
    UpdateExpression: 'SET channel = :newChannel, handoffHistory = list_append(if_not_exists(handoffHistory, :empty), :handoff), updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':newChannel': toChannel,
      ':handoff': [handoff],
      ':empty': [],
      ':updatedAt': now,
    },
  }));

  // Add system message about handoff
  await addMessageToThread(threadId, patientId, {
    content: `Conversation transferred from ${fromChannel} to ${toChannel}. Reason: ${reason}`,
    channel: toChannel,
    direction: 'OUTBOUND',
    metadata: { type: 'SYSTEM', handoff },
  });

  // Emit handoff completed event
  await emitEvent('ChannelHandoffCompleted', {
    threadId,
    patientId,
    fromChannel,
    toChannel,
    timestamp: now,
  });

  return { statusCode: 200, body: 'Handoff completed' };
}

/**
 * Handle conversation escalation
 */
async function handleEscalation(detail: any): Promise<any> {
  const { threadId, patientId, reason, priority } = detail;
  const now = new Date().toISOString();

  await docClient.send(new UpdateCommand({
    TableName: CONVERSATION_TABLE,
    Key: {
      patientId,
      messageTimestamp: `THREAD#${threadId}`,
    },
    UpdateExpression: 'SET #status = :status, priority = :priority, escalatedAt = :escalatedAt, escalationReason = :reason, updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':status': 'ESCALATED',
      ':priority': priority || 'high',
      ':escalatedAt': now,
      ':reason': reason,
      ':updatedAt': now,
    },
  }));

  // Add system message about escalation
  await addMessageToThread(threadId, patientId, {
    content: `Conversation escalated. Reason: ${reason}`,
    channel: 'sms', // Will be overridden by actual channel
    direction: 'OUTBOUND',
    metadata: { type: 'SYSTEM', escalation: { reason, priority } },
  });

  return { statusCode: 200, body: 'Escalation processed' };
}

/**
 * Find active conversation for patient on channel
 */
async function findActiveConversation(patientId: string, channel: Channel): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    KeyConditionExpression: 'patientId = :patientId AND begins_with(messageTimestamp, :prefix)',
    FilterExpression: '#status = :status AND channel = :channel',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':patientId': patientId,
      ':prefix': 'THREAD#',
      ':status': 'ACTIVE',
      ':channel': channel,
    },
    ScanIndexForward: false,
    Limit: 1,
  }));

  return result.Items?.[0];
}

/**
 * Verify patient exists
 */
async function verifyPatient(patientId: string): Promise<boolean> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: {
      patientId,
      recordType: 'PROFILE',
    },
  }));

  return !!result.Item;
}

/**
 * Record interaction for patient history
 */
async function recordInteraction(patientId: string, threadId: string, message: Message): Promise<void> {
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: INTERACTION_TABLE,
    Item: {
      patientId,
      interactionTimestamp: now,
      interactionId: uuidv4(),
      interactionType: 'MESSAGE',
      subType: message.direction,
      channel: message.channel,
      threadId,
      messageId: message.messageId,
      status: message.status,
      createdAt: now,
    },
  }));
}

/**
 * Emit event to EventBridge
 */
async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [
      {
        EventBusName: EVENT_BUS_NAME,
        Source: 'medcx.conversations',
        DetailType: detailType,
        Detail: JSON.stringify(detail),
      },
    ],
  }));
}

/**
 * Format API Gateway response
 */
function formatResponse(statusCode: number, body: any): any {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key',
    },
    body: JSON.stringify(body),
  };
}
