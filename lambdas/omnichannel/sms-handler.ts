import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
  DescribePhoneNumbersCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const lambdaClient = new LambdaClient({});
const smsClient = new PinpointSMSVoiceV2Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});

const MESSAGE_LOG_TABLE = process.env.MESSAGE_LOG_TABLE!;
const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const ORIGINATION_IDENTITY = process.env.ORIGINATION_IDENTITY!; // Phone number or Pool ID
const CONFIGURATION_SET = process.env.CONFIGURATION_SET; // Optional

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
 * SMS Handler Lambda - AWS End User Messaging
 *
 * Handles all SMS communications using AWS End User Messaging (Pinpoint SMS Voice V2):
 * - Send outbound SMS
 * - Process inbound SMS from SNS
 * - Track delivery status
 * - Support opt-in/opt-out management
 */
export const handler = async (event: any): Promise<any> => {
  console.log('SMS Handler Event:', JSON.stringify(event, null, 2));

  try {
    // Handle SNS notifications (inbound SMS from End User Messaging)
    if (event.Records?.[0]?.Sns) {
      return handleInboundSNS(event);
    }

    // Handle SQS messages (from channel router)
    if (event.Records?.[0]?.eventSource === 'aws:sqs') {
      return handleSQSMessages(event);
    }

    // Handle direct invocations
    const { action, ...data } = event;

    switch (action) {
      case 'send':
        return sendSMS(data);

      case 'sendBulk':
        return sendBulkSMS(data);

      case 'getDeliveryStatus':
        return getDeliveryStatus(data.messageId);

      case 'handleOptOut':
        return handleOptOut(data.phoneNumber);

      case 'handleOptIn':
        return handleOptIn(data.phoneNumber);

      case 'getPhoneNumbers':
        return getPhoneNumbers();

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
 * Handle SQS messages from channel router
 */
async function handleSQSMessages(event: any): Promise<any> {
  const results = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);

      if (message.channel === 'sms' || !message.channel) {
        const result = await sendSMS({
          phoneNumber: message.phoneNumber || message.destinationId,
          message: message.content || message.body || message.message,
          messageType: message.messageType || 'TRANSACTIONAL',
          patientId: message.patientId,
          metadata: message.metadata,
        });
        results.push(result);
      }
    } catch (error) {
      console.error('Error processing SQS message:', error);
      results.push({ error: 'Failed to process message' });
    }
  }

  return { processed: results.length, results };
}

/**
 * Handle inbound SMS from SNS (End User Messaging webhook)
 */
async function handleInboundSNS(event: any): Promise<any> {
  const results = [];

  for (const record of event.Records) {
    const snsMessage = JSON.parse(record.Sns.Message);

    // End User Messaging sends different event types
    if (snsMessage.eventType === 'TEXT_RECEIVED') {
      const inbound: InboundSMS = {
        originationNumber: snsMessage.originationPhoneNumber,
        destinationNumber: snsMessage.destinationPhoneNumber,
        messageBody: snsMessage.messageBody,
        messageKeyword: snsMessage.keyword,
        inboundMessageId: snsMessage.messageId,
      };

      const result = await processInboundSMS(inbound);
      results.push(result);
    } else if (snsMessage.eventType === 'TEXT_DELIVERED') {
      // Update delivery status
      await updateDeliveryStatus(snsMessage.messageId, 'delivered');
    } else if (snsMessage.eventType === 'TEXT_FAILED') {
      await updateDeliveryStatus(snsMessage.messageId, 'failed', snsMessage.failureReason);
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
 * Send outbound SMS using End User Messaging
 */
async function sendSMS(data: SMSMessage): Promise<any> {
  const { phoneNumber, message, messageType = 'TRANSACTIONAL', patientId, metadata } = data;
  const localMessageId = randomUUID();

  // Validate and normalize phone number
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  try {
    const command = new SendTextMessageCommand({
      DestinationPhoneNumber: normalizedPhone,
      OriginationIdentity: ORIGINATION_IDENTITY,
      MessageBody: message,
      MessageType: messageType,
      ConfigurationSetName: CONFIGURATION_SET,
      Context: {
        patientId: patientId || '',
        localMessageId,
      },
    });

    const response = await smsClient.send(command);

    const success = !!response.MessageId;

    // Log the message
    await logMessage({
      messageId: response.MessageId || localMessageId,
      localMessageId,
      phoneNumber: normalizedPhone,
      direction: 'outbound',
      content: message,
      channel: 'sms',
      status: success ? 'sent' : 'failed',
      patientId,
      metadata,
    });

    // Emit event
    await emitEvent(success ? 'SMSSent' : 'SMSFailed', {
      messageId: response.MessageId,
      phoneNumber: normalizedPhone,
      patientId,
      timestamp: new Date().toISOString(),
    });

    return {
      success,
      messageId: response.MessageId,
      localMessageId,
    };
  } catch (error) {
    console.error('Error sending SMS:', error);

    await logMessage({
      messageId: localMessageId,
      phoneNumber: normalizedPhone,
      direction: 'outbound',
      content: message,
      channel: 'sms',
      status: 'failed',
      patientId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      localMessageId,
    };
  }
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

    // Add delay between batches to avoid throttling
    if (i + batchSize < data.messages.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return {
    total: data.messages.length,
    sent: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
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
 * Update delivery status from webhook
 */
async function updateDeliveryStatus(
  messageId: string,
  status: string,
  failureReason?: string
): Promise<void> {
  try {
    const updateExpression = failureReason
      ? 'SET deliveryStatus = :status, failureReason = :reason, updatedAt = :updated'
      : 'SET deliveryStatus = :status, updatedAt = :updated';

    const expressionValues: any = {
      ':status': status,
      ':updated': new Date().toISOString(),
    };

    if (failureReason) {
      expressionValues[':reason'] = failureReason;
    }

    await docClient.send(new UpdateCommand({
      TableName: MESSAGE_LOG_TABLE,
      Key: { messageId },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionValues,
    }));
  } catch (error) {
    console.error('Error updating delivery status:', error);
  }
}

/**
 * Handle opt-out request
 */
async function handleOptOut(phoneNumber: string): Promise<any> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  // Update patient preferences
  await updatePatientSMSPreference(normalizedPhone, false);

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

  // Update patient preferences
  await updatePatientSMSPreference(normalizedPhone, true);

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

/**
 * Get available phone numbers
 */
async function getPhoneNumbers(): Promise<any> {
  const command = new DescribePhoneNumbersCommand({});
  const response = await smsClient.send(command);

  return {
    phoneNumbers: response.PhoneNumbers?.map(pn => ({
      phoneNumber: pn.PhoneNumber,
      status: pn.Status,
      capabilities: pn.NumberCapabilities,
      type: pn.NumberType,
    })) || [],
  };
}

// Helper functions
function normalizePhoneNumber(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  if (!digits.startsWith('+')) digits = '+' + digits;
  return digits;
}

async function updatePatientSMSPreference(phoneNumber: string, optedIn: boolean): Promise<void> {
  try {
    // Find patient by phone and update preferences
    const result = await docClient.send(new QueryCommand({
      TableName: PATIENT_TABLE,
      IndexName: 'phone-index',
      KeyConditionExpression: 'phoneNumber = :phone',
      ExpressionAttributeValues: { ':phone': phoneNumber },
    }));

    if (result.Items && result.Items.length > 0) {
      const patient = result.Items[0];
      await docClient.send(new UpdateCommand({
        TableName: PATIENT_TABLE,
        Key: { patientId: patient.patientId, recordType: 'PROFILE' },
        UpdateExpression: 'SET smsOptedIn = :opted, smsOptUpdatedAt = :updated',
        ExpressionAttributeValues: {
          ':opted': optedIn,
          ':updated': new Date().toISOString(),
        },
      }));
    }
  } catch (error) {
    console.error('Error updating patient SMS preference:', error);
  }
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
