import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { ConnectClient, StartOutboundVoiceContactCommand, StopContactCommand } from '@aws-sdk/client-connect';
import { randomUUID } from 'crypto';

const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});
const connectClient = new ConnectClient({});

const CONNECT_INSTANCE_ID = process.env.CONNECT_INSTANCE_ID!;
const CONNECT_CONTACT_FLOW_ID = process.env.CONNECT_CONTACT_FLOW_ID!;
const CONNECT_QUEUE_ID = process.env.CONNECT_QUEUE_ID!;
const SOURCE_PHONE_NUMBER = process.env.SOURCE_PHONE_NUMBER!;
const CALL_LOG_TABLE = process.env.CALL_LOG_TABLE!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface CallEvent {
  contactId: string;
  eventType: string;
  channel: string;
  initiationMethod: string;
  customerEndpoint?: { address: string; type: string };
  systemEndpoint?: { address: string; type: string };
  queue?: { arn: string; name: string };
  agent?: { arn: string; username: string };
  attributes?: Record<string, string>;
}

/**
 * Voice Handler Lambda
 *
 * Handles all voice communications via Amazon Connect:
 * - Process inbound calls via Connect contact flows
 * - Initiate outbound calls
 * - Handle call events (connected, disconnected, transferred)
 * - Support channel handoffs (voice to SMS)
 * - Integrate with conversation context
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Voice Handler Event:', JSON.stringify(event, null, 2));

  try {
    // Handle Connect contact flow invocations
    if (event.Details?.ContactData) {
      return handleContactFlowEvent(event);
    }

    // Handle Connect event stream (EventBridge)
    if (event.source === 'aws.connect') {
      return handleConnectEvent(event);
    }

    // Handle direct invocations
    const { action, ...data } = event;

    switch (action) {
      case 'initiateCall':
        return initiateOutboundCall(data);

      case 'endCall':
        return endCall(data);

      case 'getCallStatus':
        return getCallStatus(data.contactId);

      case 'handoffToSMS':
        return handoffToSMS(data);

      case 'getAgentContext':
        return getAgentContext(data);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in voice handler:', error);
    return {
      error: 'Voice operation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Handle contact flow events (Lambda invocations from Connect)
 */
async function handleContactFlowEvent(event: any): Promise<any> {
  const contactData = event.Details.ContactData;
  const parameters = event.Details.Parameters || {};
  const action = parameters.action || 'getContext';

  switch (action) {
    case 'getContext':
      return getPatientContextForCall(contactData);

    case 'logCallStart':
      return logCallStart(contactData);

    case 'logCallEnd':
      return logCallEnd(contactData, parameters);

    case 'getAppointments':
      return getPatientAppointments(contactData);

    case 'scheduleCallback':
      return scheduleCallback(contactData, parameters);

    case 'handoffToSMS':
      return handoffToSMS({
        contactId: contactData.ContactId,
        phoneNumber: contactData.CustomerEndpoint.Address,
        message: parameters.message,
      });

    default:
      return { action: 'continue' };
  }
}

/**
 * Handle Connect events from EventBridge
 */
async function handleConnectEvent(event: any): Promise<any> {
  const detail = event.detail;
  const eventType = detail.eventType;

  const callEvent: CallEvent = {
    contactId: detail.contactId,
    eventType,
    channel: detail.channel,
    initiationMethod: detail.initiationMethod,
    customerEndpoint: detail.customerEndpoint,
    systemEndpoint: detail.systemEndpoint,
    queue: detail.queue,
    agent: detail.agent,
    attributes: detail.attributes,
  };

  switch (eventType) {
    case 'INITIATED':
      await handleCallInitiated(callEvent);
      break;

    case 'CONNECTED_TO_AGENT':
      await handleCallConnectedToAgent(callEvent);
      break;

    case 'DISCONNECTED':
      await handleCallDisconnected(callEvent);
      break;

    case 'TRANSFERRED':
      await handleCallTransferred(callEvent);
      break;

    default:
      console.log('Unhandled Connect event type:', eventType);
  }

  return { handled: true, eventType };
}

/**
 * Get patient context for incoming call
 */
async function getPatientContextForCall(contactData: any): Promise<any> {
  const phoneNumber = contactData.CustomerEndpoint.Address;

  // Route through channel router to resolve identity
  const routeResult = await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'routeInbound',
    channel: 'voice',
    direction: 'INBOUND',
    phoneNumber,
    content: 'Voice call initiated',
    metadata: {
      contactId: contactData.ContactId,
      initiationMethod: contactData.InitiationMethod,
    },
  });

  if (routeResult.patientId) {
    // Get conversation context
    const context = await invokeFunction(CHANNEL_ROUTER_ARN, {
      action: 'getConversationContext',
      patientId: routeResult.patientId,
    });

    return {
      patientId: routeResult.patientId,
      patientName: context.patient?.name || 'Unknown',
      preferredChannel: context.patient?.preferredChannel || 'sms',
      lastInteraction: context.lastInteraction,
      recentChannels: context.channelHistory?.join(',') || '',
      hasAppointments: 'true', // Would check actual appointments
    };
  }

  return {
    patientId: '',
    patientName: 'New Patient',
    preferredChannel: 'sms',
    isNewPatient: 'true',
  };
}

/**
 * Initiate outbound call
 */
async function initiateOutboundCall(data: {
  phoneNumber: string;
  patientId?: string;
  attributes?: Record<string, string>;
}): Promise<any> {
  const contactId = randomUUID();

  const command = new StartOutboundVoiceContactCommand({
    InstanceId: CONNECT_INSTANCE_ID,
    ContactFlowId: CONNECT_CONTACT_FLOW_ID,
    DestinationPhoneNumber: normalizePhoneNumber(data.phoneNumber),
    SourcePhoneNumber: SOURCE_PHONE_NUMBER,
    QueueId: CONNECT_QUEUE_ID,
    Attributes: {
      patientId: data.patientId || '',
      callType: 'outbound',
      ...data.attributes,
    },
  });

  const response = await connectClient.send(command);

  await logCallStart({
    ContactId: response.ContactId,
    CustomerEndpoint: { Address: data.phoneNumber },
    InitiationMethod: 'OUTBOUND',
    Attributes: data.attributes,
  });

  await emitEvent('OutboundCallInitiated', {
    contactId: response.ContactId,
    phoneNumber: data.phoneNumber,
    patientId: data.patientId,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    contactId: response.ContactId,
    phoneNumber: data.phoneNumber,
  };
}

/**
 * End call
 */
async function endCall(data: { contactId: string }): Promise<any> {
  const command = new StopContactCommand({
    InstanceId: CONNECT_INSTANCE_ID,
    ContactId: data.contactId,
  });

  await connectClient.send(command);

  return { success: true, contactId: data.contactId };
}

/**
 * Get call status
 */
async function getCallStatus(contactId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: CALL_LOG_TABLE,
    Key: { contactId },
  }));

  if (!result.Item) {
    return { error: 'Call not found' };
  }

  return result.Item;
}

/**
 * Handoff to SMS
 */
async function handoffToSMS(data: {
  contactId?: string;
  phoneNumber: string;
  message?: string;
  patientId?: string;
}): Promise<any> {
  // Get patient ID from call if not provided
  let patientId = data.patientId;
  if (!patientId && data.contactId) {
    const callStatus = await getCallStatus(data.contactId);
    patientId = callStatus.patientId;
  }

  // Route handoff through channel router
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'handoffChannel',
    patientId,
    fromChannel: 'voice',
    toChannel: 'sms',
    message: data.message || 'Thank you for calling. We will continue our conversation via text message.',
  });

  await emitEvent('VoiceToSMSHandoff', {
    contactId: data.contactId,
    phoneNumber: data.phoneNumber,
    patientId,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    handoff: 'voice_to_sms',
    message: 'Handoff initiated',
  };
}

/**
 * Get agent context (for screen pop)
 */
async function getAgentContext(data: {
  contactId: string;
  agentId: string;
}): Promise<any> {
  const callStatus = await getCallStatus(data.contactId);

  if (!callStatus?.patientId) {
    return { error: 'No patient context available' };
  }

  const context = await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'getConversationContext',
    patientId: callStatus.patientId,
  });

  return {
    ...context,
    contactId: data.contactId,
    callStartTime: callStatus.startTime,
    initiationMethod: callStatus.initiationMethod,
  };
}

// Event handlers
async function handleCallInitiated(event: CallEvent): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: CALL_LOG_TABLE,
    Item: {
      contactId: event.contactId,
      phoneNumber: event.customerEndpoint?.address,
      initiationMethod: event.initiationMethod,
      channel: event.channel,
      status: 'initiated',
      startTime: new Date().toISOString(),
      attributes: event.attributes,
    },
  }));

  await emitEvent('CallInitiated', {
    contactId: event.contactId,
    phoneNumber: event.customerEndpoint?.address,
    initiationMethod: event.initiationMethod,
    timestamp: new Date().toISOString(),
  });
}

async function handleCallConnectedToAgent(event: CallEvent): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: CALL_LOG_TABLE,
    Key: { contactId: event.contactId },
    UpdateExpression: 'SET #status = :status, agentId = :agentId, agentConnectedTime = :time',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'connected',
      ':agentId': event.agent?.username,
      ':time': new Date().toISOString(),
    },
  }));

  await emitEvent('CallConnectedToAgent', {
    contactId: event.contactId,
    agentId: event.agent?.username,
    timestamp: new Date().toISOString(),
  });
}

async function handleCallDisconnected(event: CallEvent): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: CALL_LOG_TABLE,
    Key: { contactId: event.contactId },
    UpdateExpression: 'SET #status = :status, endTime = :endTime',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'disconnected',
      ':endTime': new Date().toISOString(),
    },
  }));

  await emitEvent('CallDisconnected', {
    contactId: event.contactId,
    timestamp: new Date().toISOString(),
  });
}

async function handleCallTransferred(event: CallEvent): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: CALL_LOG_TABLE,
    Key: { contactId: event.contactId },
    UpdateExpression: 'SET #status = :status, transferredTime = :time, transferQueue = :queue',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'transferred',
      ':time': new Date().toISOString(),
      ':queue': event.queue?.name,
    },
  }));

  await emitEvent('CallTransferred', {
    contactId: event.contactId,
    queue: event.queue?.name,
    timestamp: new Date().toISOString(),
  });
}

async function logCallStart(contactData: any): Promise<any> {
  await docClient.send(new PutCommand({
    TableName: CALL_LOG_TABLE,
    Item: {
      contactId: contactData.ContactId,
      phoneNumber: contactData.CustomerEndpoint?.Address,
      initiationMethod: contactData.InitiationMethod,
      status: 'started',
      startTime: new Date().toISOString(),
      attributes: contactData.Attributes,
    },
  }));

  return { logged: true };
}

async function logCallEnd(contactData: any, parameters: any): Promise<any> {
  await docClient.send(new UpdateCommand({
    TableName: CALL_LOG_TABLE,
    Key: { contactId: contactData.ContactId },
    UpdateExpression: 'SET #status = :status, endTime = :endTime, disposition = :disposition',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'ended',
      ':endTime': new Date().toISOString(),
      ':disposition': parameters.disposition || 'completed',
    },
  }));

  return { logged: true };
}

async function getPatientAppointments(contactData: any): Promise<any> {
  // This would fetch from appointments service
  return {
    hasUpcoming: 'true',
    nextAppointmentDate: '',
    nextAppointmentTime: '',
  };
}

async function scheduleCallback(contactData: any, parameters: any): Promise<any> {
  await emitEvent('CallbackScheduled', {
    contactId: contactData.ContactId,
    phoneNumber: contactData.CustomerEndpoint?.Address,
    callbackTime: parameters.callbackTime,
    reason: parameters.reason,
    timestamp: new Date().toISOString(),
  });

  return { scheduled: true };
}

// Helper functions
function normalizePhoneNumber(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  if (!digits.startsWith('+')) digits = '+' + digits;
  return digits;
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
      Source: 'medcx.voice',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
