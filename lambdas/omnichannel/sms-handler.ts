import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { PinpointClient, SendMessagesCommand, PhoneNumberValidateCommand } from '@aws-sdk/client-pinpoint';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const lambdaClient = new LambdaClient({});
const pinpointClient = new PinpointClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});

const PINPOINT_APP_ID = process.env.PINPOINT_APP_ID!;
const MESSAGE_LOG_TABLE = process.env.MESSAGE_LOG_TABLE!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface SMSMessage {
  phoneNumber: string;
  message: string;
  messageType?: 'TRANSACTIONAL' | 'PROMOTIONAL';
  patientId?: string;
  metadata?: Record<string, any>;
}

interface InboundSMS {
  originationNumber: string;
  destinationNumber: string;
  messageBody: string;
  messageKeyword?: string;
  inboundMessageId: string;
}

/**
 * SMS Handler Lambda
 *
 * Handles all SMS communications:
 * - Send outbound SMS via Amazon Pinpoint
 * - Process inbound SMS from Pinpoint/SNS
 * - Validate phone numbers
 * - Track delivery status
 * - Support opt-in/opt-out management
 */
export const handler = async (event: any): Promise<any> => {
  console.log('SMS Handler Event:', JSON.stringify(event, null, 2));

  try {
    // Handle SNS notifications (inbound SMS)
    if (event.Records?.[0]?.Sns) {
      return handleInboundSNS(event);
    }

    // Handle direct invocations
    const { action, ...data } = event;

    switch (action) {
      case 'send':
        return sendSMS(data);

      case 'sendBulk':
        return sendBulkSMS(data);

      case 'validateNumber':
        return validatePhoneNumber(data.phoneNumber);

      case 'getDeliveryStatus':
        return getDeliveryStatus(data.messageId);

      case 'handleOptOut':
        return handleOptOut(data.phoneNumber);

      case 'handleOptIn':
        return handleOptIn(data.phoneNumber);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in SMS handler:', error);
    return {
      error: 'SMS operation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Handle inbound SMS from SNS
 */
async function handleInboundSNS(event: any): Promise<any> {
  const results = [];

  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);

    if (message.messageType === 'SMS') {
      const inbound: InboundSMS = {
        originationNumber: message.originationNumber,
        destinationNumber: message.destinationNumber,
        messageBody: message.messageBody,
        messageKeyword: message.messageKeyword,
        inboundMessageId: message.inboundMessageId,
      };

      const result = await processInboundSMS(inbound);
      results.push(result);
    }
  }

  return { processed: results.length, results };
}

/**
 * Process inbound SMS
 */
async function processInboundSMS(message: InboundSMS): Promise<any> {
  const { originationNumber, messageBody, messageKeyword } = message;

  // Check for opt-out keywords
  const optOutKeywords = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
  if (optOutKeywords.includes(messageBody.toUpperCase().trim())) {
    return handleOptOut(originationNumber);
  }

  // Check for opt-in keywords
  const optInKeywords = ['START', 'SUBSCRIBE', 'YES', 'UNSTOP'];
  if (optInKeywords.includes(messageBody.toUpperCase().trim())) {
    return handleOptIn(originationNumber);
  }

  // Log the message
  await logMessage({
    messageId: message.inboundMessageId,
    phoneNumber: originationNumber,
    direction: 'inbound',
    content: messageBody,
    channel: 'sms',
    status: 'received',
  });

  // Route through channel router
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'routeInbound',
    channel: 'sms',
    direction: 'inbound',
    phoneNumber: originationNumber,
    content: messageBody,
    metadata: {
      keyword: messageKeyword,
      inboundMessageId: message.inboundMessageId,
    },
  });

  // Emit event
  await emitEvent('SMSReceived', {
    phoneNumber: originationNumber,
    messageBody,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    messageId: message.inboundMessageId,
    action: 'routed',
  };
}

/**
 * Send outbound SMS
 */
async function sendSMS(data: SMSMessage): Promise<any> {
  const { phoneNumber, message, messageType = 'TRANSACTIONAL', patientId, metadata } = data;
  const messageId = randomUUID();

  // Validate phone number format
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  const command = new SendMessagesCommand({
    ApplicationId: PINPOINT_APP_ID,
    MessageRequest: {
      Addresses: {
        [normalizedPhone]: {
          ChannelType: 'SMS',
        },
      },
      MessageConfiguration: {
        SMSMessage: {
          Body: message,
          MessageType: messageType,
          OriginationNumber: process.env.ORIGINATION_NUMBER,
        },
      },
    },
  });

  const response = await pinpointClient.send(command);
  const result = response.MessageResponse?.Result?.[normalizedPhone];

  const success = result?.StatusCode === 200;

  // Log the message
  await logMessage({
    messageId: result?.MessageId || messageId,
    phoneNumber: normalizedPhone,
    direction: 'outbound',
    content: message,
    channel: 'sms',
    status: success ? 'sent' : 'failed',
    patientId,
    metadata,
    deliveryStatus: result?.DeliveryStatus,
    statusMessage: result?.StatusMessage,
  });

  // Emit event
  await emitEvent(success ? 'SMSSent' : 'SMSFailed', {
    messageId: result?.MessageId,
    phoneNumber: normalizedPhone,
    patientId,
    status: result?.DeliveryStatus,
    timestamp: new Date().toISOString(),
  });

  return {
    success,
    messageId: result?.MessageId,
    deliveryStatus: result?.DeliveryStatus,
    statusMessage: result?.StatusMessage,
  };
}

/**
 * Send bulk SMS
 */
async function sendBulkSMS(data: { messages: SMSMessage[] }): Promise<any> {
  const results = [];
  const batchSize = 50;

  for (let i = 0; i < data.messages.length; i += batchSize) {
    const batch = data.messages.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(msg => sendSMS(msg))
    );
    results.push(...batchResults);
  }

  return {
    total: data.messages.length,
    sent: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  };
}

/**
 * Validate phone number
 */
async function validatePhoneNumber(phoneNumber: string): Promise<any> {
  const command = new PhoneNumberValidateCommand({
    NumberValidateRequest: {
      PhoneNumber: phoneNumber,
    },
  });

  const response = await pinpointClient.send(command);
  const result = response.NumberValidateResponse;

  return {
    valid: result?.PhoneType !== 'INVALID',
    phoneNumber: result?.CleansedPhoneNumberE164,
    carrier: result?.Carrier,
    countryCode: result?.CountryCodeIso2,
    phoneType: result?.PhoneType,
    timezone: result?.Timezone,
  };
}

/**
 * Get delivery status
 */
async function getDeliveryStatus(messageId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: MESSAGE_LOG_TABLE,
    IndexName: 'messageId-index',
    KeyConditionExpression: 'messageId = :messageId',
    ExpressionAttributeValues: { ':messageId': messageId },
  }));

  if (!result.Items || result.Items.length === 0) {
    return { error: 'Message not found' };
  }

  return result.Items[0];
}

/**
 * Handle opt-out request
 */
async function handleOptOut(phoneNumber: string): Promise<any> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  await logMessage({
    messageId: `optout-${Date.now()}`,
    phoneNumber: normalizedPhone,
    direction: 'inbound',
    content: 'OPT-OUT',
    channel: 'sms',
    status: 'opt-out',
  });

  await emitEvent('SMSOptOut', {
    phoneNumber: normalizedPhone,
    timestamp: new Date().toISOString(),
  });

  // Send confirmation
  await sendSMS({
    phoneNumber: normalizedPhone,
    message: 'You have been unsubscribed from MedCX messages. Reply START to resubscribe.',
    messageType: 'TRANSACTIONAL',
  });

  return {
    success: true,
    action: 'opt-out',
    phoneNumber: normalizedPhone,
  };
}

/**
 * Handle opt-in request
 */
async function handleOptIn(phoneNumber: string): Promise<any> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  await logMessage({
    messageId: `optin-${Date.now()}`,
    phoneNumber: normalizedPhone,
    direction: 'inbound',
    content: 'OPT-IN',
    channel: 'sms',
    status: 'opt-in',
  });

  await emitEvent('SMSOptIn', {
    phoneNumber: normalizedPhone,
    timestamp: new Date().toISOString(),
  });

  // Send confirmation
  await sendSMS({
    phoneNumber: normalizedPhone,
    message: 'Welcome back! You are now subscribed to MedCX messages. Reply STOP to unsubscribe.',
    messageType: 'TRANSACTIONAL',
  });

  return {
    success: true,
    action: 'opt-in',
    phoneNumber: normalizedPhone,
  };
}

// Helper functions
function normalizePhoneNumber(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  if (!digits.startsWith('+')) digits = '+' + digits;
  return digits;
}

async function logMessage(data: any): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: MESSAGE_LOG_TABLE,
    Item: {
      ...data,
      timestamp: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 days
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
      Source: 'medcx.sms',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
