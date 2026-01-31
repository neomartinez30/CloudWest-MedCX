import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sqsClient = new SQSClient({});
const lambdaClient = new LambdaClient({});
const eventBridge = new EventBridgeClient({});

const CAMPAIGN_TABLE = process.env.CAMPAIGN_TABLE!;
const SEGMENT_TABLE = process.env.SEGMENT_TABLE!;
const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const OUTREACH_LOG_TABLE = process.env.OUTREACH_LOG_TABLE!;
const OUTREACH_QUEUE_URL = process.env.OUTREACH_QUEUE_URL!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface OutreachMessage {
  patientId: string;
  channel: string;
  content: string;
  campaignId?: string;
  metadata?: Record<string, any>;
}

/**
 * Outreach Sender Lambda
 *
 * Sends outreach messages to patients:
 * - Execute campaign messages
 * - Handle message personalization
 * - Track delivery and responses
 * - Respect opt-out preferences
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Outreach Sender Event:', JSON.stringify(event, null, 2));

  try {
    // Handle SQS messages
    if (event.Records?.[0]?.body) {
      return handleSQSMessages(event);
    }

    const { action, ...data } = event;

    switch (action) {
      case 'sendBulkOutreach':
        return sendBulkOutreach(data);

      case 'sendSingleOutreach':
        return sendSingleOutreach(data);

      case 'executeCampaign':
        return executeCampaign(data.campaignId);

      case 'processMessage':
        return processMessage(data);

      case 'getDeliveryStatus':
        return getDeliveryStatus(data.outreachId);

      case 'getPatientOutreachHistory':
        return getPatientOutreachHistory(data.patientId);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in outreach sender:', error);
    return {
      error: 'Outreach failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Handle SQS messages for batch processing
 */
async function handleSQSMessages(event: any): Promise<any> {
  const results = [];

  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    const result = await processMessage(message);
    results.push(result);
  }

  return { processed: results.length, results };
}

/**
 * Send bulk outreach to segment
 */
async function sendBulkOutreach(data: {
  campaignId: string;
  segmentId: string;
  message: { template: string; variables?: Record<string, string> };
  channels: string[];
}): Promise<any> {
  const { campaignId, segmentId, message, channels } = data;
  const now = new Date().toISOString();

  // Get segment members
  const segmentResult = await docClient.send(new GetCommand({
    TableName: SEGMENT_TABLE,
    Key: { segmentId },
  }));

  const segment = segmentResult.Item;
  if (!segment) {
    return { error: 'Segment not found' };
  }

  const patientIds = segment.patientIds || [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  // Batch messages to SQS
  const batchSize = 10;
  for (let i = 0; i < patientIds.length; i += batchSize) {
    const batch = patientIds.slice(i, i + batchSize);

    const entries = batch.map((patientId: string, index: number) => ({
      Id: `${index}`,
      MessageBody: JSON.stringify({
        action: 'processMessage',
        patientId,
        campaignId,
        message,
        channels,
      }),
    }));

    try {
      await sqsClient.send(new SendMessageBatchCommand({
        QueueUrl: OUTREACH_QUEUE_URL,
        Entries: entries,
      }));
      sent += entries.length;
    } catch (error) {
      console.error('Error queueing batch:', error);
      failed += entries.length;
    }
  }

  // Update campaign metrics
  await docClient.send(new UpdateCommand({
    TableName: CAMPAIGN_TABLE,
    Key: { campaignId },
    UpdateExpression: 'SET metrics.sent = :sent, metrics.queued = :queued, updatedAt = :updated',
    ExpressionAttributeValues: {
      ':sent': sent,
      ':queued': sent,
      ':updated': now,
    },
  }));

  await emitEvent('BulkOutreachQueued', {
    campaignId,
    segmentId,
    queued: sent,
    skipped,
    failed,
    timestamp: now,
  });

  return {
    success: true,
    campaignId,
    metrics: { queued: sent, skipped, failed },
  };
}

/**
 * Send single outreach message
 */
async function sendSingleOutreach(data: OutreachMessage): Promise<any> {
  const { patientId, channel, content, campaignId, metadata } = data;
  const outreachId = randomUUID();
  const now = new Date().toISOString();

  // Check opt-out status
  const patient = await getPatient(patientId);
  if (!patient) {
    return { error: 'Patient not found' };
  }

  if (patient.optedOut) {
    await logOutreach({
      outreachId,
      patientId,
      campaignId,
      channel,
      status: 'skipped',
      reason: 'opted_out',
    });

    return { success: false, outreachId, status: 'skipped', reason: 'opted_out' };
  }

  // Personalize message
  const personalizedContent = personalizeMessage(content, patient);

  // Send via channel router
  try {
    await invokeFunction(CHANNEL_ROUTER_ARN, {
      action: 'sendOutbound',
      channel,
      patientId,
      content: personalizedContent,
      metadata: {
        ...metadata,
        campaignId,
        outreachId,
      },
    });

    await logOutreach({
      outreachId,
      patientId,
      campaignId,
      channel,
      content: personalizedContent,
      status: 'sent',
    });

    return { success: true, outreachId, status: 'sent' };
  } catch (error) {
    await logOutreach({
      outreachId,
      patientId,
      campaignId,
      channel,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      success: false,
      outreachId,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Execute a campaign
 */
async function executeCampaign(campaignId: string): Promise<any> {
  const campaignResult = await docClient.send(new GetCommand({
    TableName: CAMPAIGN_TABLE,
    Key: { campaignId },
  }));

  const campaign = campaignResult.Item;
  if (!campaign) {
    return { error: 'Campaign not found' };
  }

  return sendBulkOutreach({
    campaignId,
    segmentId: campaign.segmentId,
    message: campaign.message,
    channels: campaign.channels,
  });
}

/**
 * Process a single message from queue
 */
async function processMessage(data: {
  patientId: string;
  campaignId?: string;
  message: { template: string; variables?: Record<string, string> };
  channels: string[];
}): Promise<any> {
  const { patientId, campaignId, message, channels } = data;

  // Get patient
  const patient = await getPatient(patientId);
  if (!patient) {
    return { error: 'Patient not found' };
  }

  // Check opt-out
  if (patient.optedOut) {
    return { skipped: true, reason: 'opted_out' };
  }

  // Determine best channel
  const channel = patient.preferredChannel || channels[0] || 'sms';

  // Personalize message
  const content = personalizeMessage(message.template, patient, message.variables);

  return sendSingleOutreach({
    patientId,
    channel,
    content,
    campaignId,
    metadata: { processedFromQueue: true },
  });
}

/**
 * Get delivery status
 */
async function getDeliveryStatus(outreachId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: OUTREACH_LOG_TABLE,
    Key: { outreachId },
  }));

  return result.Item || { error: 'Outreach not found' };
}

/**
 * Get patient outreach history
 */
async function getPatientOutreachHistory(patientId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: OUTREACH_LOG_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
    Limit: 50,
  }));

  return {
    patientId,
    outreach: result.Items || [],
    count: result.Items?.length || 0,
  };
}

// Helper functions
async function getPatient(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));
  return result.Item;
}

function personalizeMessage(
  template: string,
  patient: any,
  variables?: Record<string, string>
): string {
  let content = template;

  // Standard patient variables
  const patientVars: Record<string, string> = {
    firstName: patient.firstName || 'there',
    lastName: patient.lastName || '',
    fullName: `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'Patient',
    phoneNumber: patient.phoneNumber || '',
    email: patient.email || '',
  };

  // Replace patient variables
  for (const [key, value] of Object.entries(patientVars)) {
    content = content.replace(new RegExp(`{{${key}}}`, 'gi'), value);
  }

  // Replace custom variables
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      content = content.replace(new RegExp(`{{${key}}}`, 'gi'), value);
    }
  }

  return content;
}

async function logOutreach(data: {
  outreachId: string;
  patientId: string;
  campaignId?: string;
  channel: string;
  content?: string;
  status: string;
  reason?: string;
  error?: string;
}): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: OUTREACH_LOG_TABLE,
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
  });
  const response = await lambdaClient.send(command);
  return JSON.parse(new TextDecoder().decode(response.Payload));
}

async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [{
      EventBusName: EVENT_BUS_NAME,
      Source: 'medcx.outreach',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
