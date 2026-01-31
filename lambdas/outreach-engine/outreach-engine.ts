import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { PinpointClient, SendMessagesCommand } from '@aws-sdk/client-pinpoint';
import {
  SESClient,
  SendEmailCommand,
} from '@aws-sdk/client-ses';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const pinpointClient = new PinpointClient({});
const sesClient = new SESClient({});
const eventBridge = new EventBridgeClient({});
const lambdaClient = new LambdaClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CAMPAIGNS_TABLE = process.env.CAMPAIGNS_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const PINPOINT_APP_ID = process.env.PINPOINT_APP_ID!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@cloudwestmedical.com';
const PRACTICE_NAME = process.env.PRACTICE_NAME || 'CloudWest Medical';

interface CampaignConfig {
  name: string;
  description?: string;
  type: 'reminder' | 'reactivation' | 'wellness' | 'promotion' | 'survey' | 'custom';
  channel: 'sms' | 'email' | 'both';
  targetCriteria: TargetCriteria;
  content: {
    smsTemplate?: string;
    emailSubject?: string;
    emailBody?: string;
  };
}

interface TargetCriteria {
  lastVisitDaysAgo?: { min?: number; max?: number };
  hasUpcomingAppointment?: boolean;
  tags?: string[];
  excludeTags?: string[];
}

interface Campaign {
  campaignId: string;
  name: string;
  description?: string;
  type: string;
  channel: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
  targetCriteria: TargetCriteria;
  content: any;
  stats: {
    totalTargeted: number;
    totalSent: number;
    totalDelivered: number;
    totalFailed: number;
  };
  createdAt: string;
  updatedAt: string;
}

interface OutreachRequest {
  action: 'sendAppointmentReminders' | 'sendBulkMessage' | 'startOnboardingCampaign' | 'sendReactivation' | 'create-campaign' | 'start-campaign' | 'pause-campaign' | 'cancel-campaign' | 'get-campaign' | 'list-campaigns' | 'get-analytics';
  patientId?: string;
  patientIds?: string[];
  campaignId?: string;
  campaign?: CampaignConfig;
  reminderType?: '24_hours' | '2_hours' | '1_day';
  message?: string;
  channel?: 'sms' | 'email' | 'both';
  reactivationDays?: number;
}

/**
 * Outreach Engine Lambda
 *
 * Handles proactive patient outreach:
 * - Appointment reminders (24 hours, 2 hours before)
 * - Bulk messaging campaigns
 * - New patient onboarding sequences
 * - Patient reactivation campaigns
 * - Marketing communications
 */
export const handler = async (event: OutreachRequest | any): Promise<any> => {
  console.log('Outreach Engine Event:', JSON.stringify(event, null, 2));

  try {
    const { action } = event;

    switch (action) {
      case 'sendAppointmentReminders':
        return sendAppointmentReminders(event.reminderType || '24_hours');

      case 'sendBulkMessage':
        return sendBulkMessage(event.patientIds || [], event.message!, event.channel || 'sms');

      case 'startOnboardingCampaign':
        return startOnboardingCampaign(event.patientId!);

      case 'sendReactivation':
        return sendReactivationMessage(event.patientId!);

      // Campaign management actions
      case 'create-campaign':
        return createCampaign(event.campaign);

      case 'start-campaign':
        return startCampaign(event.campaignId!);

      case 'pause-campaign':
        return pauseCampaign(event.campaignId!);

      case 'cancel-campaign':
        return cancelCampaign(event.campaignId!);

      case 'get-campaign':
        return getCampaign(event.campaignId!);

      case 'list-campaigns':
        return listCampaigns();

      case 'get-analytics':
        return getAnalytics(event.campaignId);

      default:
        return formatResponse(400, {
          error: 'Unknown action',
          validActions: ['sendAppointmentReminders', 'sendBulkMessage', 'startOnboardingCampaign', 'sendReactivation', 'create-campaign', 'start-campaign', 'pause-campaign', 'cancel-campaign', 'get-campaign', 'list-campaigns', 'get-analytics'],
        });
    }
  } catch (error) {
    console.error('Error in outreach engine:', error);
    return formatResponse(500, {
      error: 'Failed to process outreach request',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Send appointment reminders
 */
async function sendAppointmentReminders(reminderType: string): Promise<any> {
  const now = new Date();
  let targetTime: Date;

  switch (reminderType) {
    case '24_hours':
      targetTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      break;
    case '2_hours':
      targetTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      break;
    default:
      targetTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }

  // Query appointments in the target window
  const startWindow = new Date(targetTime.getTime() - 30 * 60 * 1000).toISOString();
  const endWindow = new Date(targetTime.getTime() + 30 * 60 * 1000).toISOString();

  const result = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'date-index',
    KeyConditionExpression: 'appointmentDate = :date AND appointmentTime BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':date': targetTime.toISOString().split('T')[0],
      ':start': startWindow.split('T')[1],
      ':end': endWindow.split('T')[1],
    },
  }));

  const appointments = result.Items || [];
  let sentCount = 0;

  for (const apt of appointments) {
    if (apt.status === 'scheduled' && apt.patientPhone) {
      const message = buildReminderMessage(apt, reminderType);
      await sendSMS(apt.patientPhone, message);

      await recordOutreach(apt.patientId, 'appointment_reminder', reminderType);
      sentCount++;
    }
  }

  await emitEvent('AppointmentRemindersSent', {
    reminderType,
    sentCount,
    timestamp: now.toISOString(),
  });

  return {
    success: true,
    reminderType,
    sentCount,
  };
}

/**
 * Send bulk message to multiple patients
 */
async function sendBulkMessage(
  patientIds: string[],
  message: string,
  channel: string
): Promise<any> {
  let successCount = 0;
  let failCount = 0;

  for (const patientId of patientIds) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: CHANNEL_ROUTER_ARN,
        Payload: JSON.stringify({
          action: 'sendOutbound',
          patientId,
          channel,
          content: message,
        }),
      }));
      successCount++;
    } catch {
      failCount++;
    }
  }

  await emitEvent('BulkMessageSent', {
    totalPatients: patientIds.length,
    successCount,
    failCount,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    totalPatients: patientIds.length,
    successCount,
    failCount,
  };
}

/**
 * Start onboarding campaign for new patient
 */
async function startOnboardingCampaign(patientId: string): Promise<any> {
  const welcomeMessage = `Welcome to CloudWest Medical! We're excited to have you as a patient.

Reply "SCHEDULE" to book your first appointment, or "INFO" to learn more about our services.

Need help? Just reply to this message and we'll assist you.`;

  await lambdaClient.send(new InvokeCommand({
    FunctionName: CHANNEL_ROUTER_ARN,
    Payload: JSON.stringify({
      action: 'sendOutbound',
      patientId,
      channel: 'sms',
      content: welcomeMessage,
    }),
  }));

  await recordOutreach(patientId, 'onboarding', 'welcome');

  await emitEvent('OnboardingStarted', {
    patientId,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    patientId,
    campaign: 'onboarding',
  };
}

/**
 * Send reactivation message to inactive patient
 */
async function sendReactivationMessage(patientId: string): Promise<any> {
  const message = `Hi! We noticed it's been a while since your last visit to CloudWest Medical.

We'd love to see you again! Reply "SCHEDULE" to book an appointment, or "REMOVE" to opt out of reminders.

Your health is our priority!`;

  await lambdaClient.send(new InvokeCommand({
    FunctionName: CHANNEL_ROUTER_ARN,
    Payload: JSON.stringify({
      action: 'sendOutbound',
      patientId,
      channel: 'sms',
      content: message,
    }),
  }));

  await recordOutreach(patientId, 'reactivation', 'initial');

  return {
    success: true,
    patientId,
    campaign: 'reactivation',
  };
}

/**
 * Build reminder message based on type
 */
function buildReminderMessage(appointment: any, reminderType: string): string {
  const date = new Date(appointment.appointmentDateTime);
  const formattedDate = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const formattedTime = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  if (reminderType === '2_hours') {
    return `Reminder: Your appointment at CloudWest Medical is in 2 hours (${formattedTime}). Please arrive 10 minutes early. Reply CONFIRM or CANCEL.`;
  }

  return `Reminder: You have an appointment at CloudWest Medical tomorrow, ${formattedDate} at ${formattedTime}. Reply CONFIRM or CANCEL.`;
}

/**
 * Send SMS via Pinpoint
 */
async function sendSMS(phoneNumber: string, message: string): Promise<void> {
  await pinpointClient.send(new SendMessagesCommand({
    ApplicationId: PINPOINT_APP_ID,
    MessageRequest: {
      Addresses: {
        [phoneNumber]: { ChannelType: 'SMS' },
      },
      MessageConfiguration: {
        SMSMessage: {
          Body: message,
          MessageType: 'TRANSACTIONAL',
        },
      },
    },
  }));
}

/**
 * Record outreach interaction
 */
async function recordOutreach(patientId: string, campaign: string, step: string): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: INTERACTION_TABLE,
    Item: {
      patientId,
      interactionTimestamp: new Date().toISOString(),
      interactionId: randomUUID(),
      interactionType: 'OUTREACH',
      subType: step,
      campaign,
      channel: 'sms',
      direction: 'OUTBOUND',
      status: 'COMPLETED',
      createdAt: new Date().toISOString(),
    },
  }));
}

/**
 * Emit event to EventBridge
 */
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

// ============================================================================
// Campaign Management Functions
// ============================================================================

/**
 * Create a new outreach campaign
 */
async function createCampaign(config: CampaignConfig): Promise<any> {
  if (!config || !config.name || !config.type || !config.channel) {
    return formatResponse(400, {
      error: 'Missing required campaign fields',
      required: ['name', 'type', 'channel'],
    });
  }

  const campaignId = randomUUID();
  const now = new Date().toISOString();

  const campaign: Campaign = {
    campaignId,
    name: config.name,
    description: config.description,
    type: config.type,
    channel: config.channel,
    status: 'draft',
    targetCriteria: config.targetCriteria || {},
    content: config.content || {},
    stats: {
      totalTargeted: 0,
      totalSent: 0,
      totalDelivered: 0,
      totalFailed: 0,
    },
    createdAt: now,
    updatedAt: now,
  };

  // Estimate target audience
  const targetedPatients = await findTargetedPatients(campaign.targetCriteria);
  campaign.stats.totalTargeted = targetedPatients.length;

  await docClient.send(new PutCommand({
    TableName: CAMPAIGNS_TABLE,
    Item: campaign,
  }));

  await emitEvent('CampaignCreated', {
    campaignId,
    name: config.name,
    type: config.type,
    targetedCount: campaign.stats.totalTargeted,
    timestamp: now,
  });

  return formatResponse(201, {
    message: 'Campaign created successfully',
    campaign,
  });
}

/**
 * Start a campaign
 */
async function startCampaign(campaignId: string): Promise<any> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return formatResponse(404, { error: 'Campaign not found' });
  }

  if (!['draft', 'paused'].includes(campaign.status)) {
    return formatResponse(400, { error: `Cannot start campaign with status: ${campaign.status}` });
  }

  const now = new Date().toISOString();
  const patients = await findTargetedPatients(campaign.targetCriteria);

  if (patients.length === 0) {
    return formatResponse(400, { error: 'No patients match the target criteria' });
  }

  await docClient.send(new UpdateCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { campaignId },
    UpdateExpression: 'SET #status = :status, startedAt = :startedAt, updatedAt = :updatedAt, stats.totalTargeted = :targeted',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'running',
      ':startedAt': now,
      ':updatedAt': now,
      ':targeted': patients.length,
    },
  }));

  // Queue outreach for each patient
  let sentCount = 0;
  for (const patient of patients) {
    await sendCampaignMessage(campaign, patient);
    sentCount++;
  }

  await emitEvent('CampaignStarted', {
    campaignId,
    name: campaign.name,
    targetedPatients: patients.length,
    timestamp: now,
  });

  return formatResponse(200, {
    message: 'Campaign started',
    campaignId,
    targetedPatients: patients.length,
    sentCount,
  });
}

/**
 * Pause a running campaign
 */
async function pauseCampaign(campaignId: string): Promise<any> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return formatResponse(404, { error: 'Campaign not found' });
  }

  if (campaign.status !== 'running') {
    return formatResponse(400, { error: 'Can only pause running campaigns' });
  }

  const now = new Date().toISOString();

  await docClient.send(new UpdateCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { campaignId },
    UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'paused',
      ':updatedAt': now,
    },
  }));

  await emitEvent('CampaignPaused', { campaignId, timestamp: now });

  return formatResponse(200, { message: 'Campaign paused', campaignId });
}

/**
 * Cancel a campaign
 */
async function cancelCampaign(campaignId: string): Promise<any> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return formatResponse(404, { error: 'Campaign not found' });
  }

  if (['completed', 'cancelled'].includes(campaign.status)) {
    return formatResponse(400, { error: `Campaign is already ${campaign.status}` });
  }

  const now = new Date().toISOString();

  await docClient.send(new UpdateCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { campaignId },
    UpdateExpression: 'SET #status = :status, completedAt = :completedAt, updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'cancelled',
      ':completedAt': now,
      ':updatedAt': now,
    },
  }));

  await emitEvent('CampaignCancelled', { campaignId, timestamp: now });

  return formatResponse(200, { message: 'Campaign cancelled', campaignId });
}

/**
 * Get campaign details
 */
async function getCampaign(campaignId: string): Promise<any> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return formatResponse(404, { error: 'Campaign not found' });
  }
  return formatResponse(200, { campaign });
}

/**
 * List all campaigns
 */
async function listCampaigns(): Promise<any> {
  const result = await docClient.send(new ScanCommand({
    TableName: CAMPAIGNS_TABLE,
    ProjectionExpression: 'campaignId, #name, #type, channel, #status, stats, createdAt',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#type': 'type',
      '#status': 'status',
    },
  }));

  const campaigns = result.Items?.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ) || [];

  return formatResponse(200, { campaigns, total: campaigns.length });
}

/**
 * Get analytics for a campaign or overall
 */
async function getAnalytics(campaignId?: string): Promise<any> {
  if (campaignId) {
    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return formatResponse(404, { error: 'Campaign not found' });
    }

    return formatResponse(200, {
      campaign: { campaignId, name: campaign.name, status: campaign.status },
      stats: campaign.stats,
      metrics: {
        deliveryRate: campaign.stats.totalSent > 0
          ? ((campaign.stats.totalDelivered / campaign.stats.totalSent) * 100).toFixed(2) + '%'
          : 'N/A',
      },
    });
  }

  const result = await docClient.send(new ScanCommand({
    TableName: CAMPAIGNS_TABLE,
    ProjectionExpression: 'stats, #status',
    ExpressionAttributeNames: { '#status': 'status' },
  }));

  const aggregated = {
    totalCampaigns: result.Items?.length || 0,
    totalSent: 0,
    totalDelivered: 0,
    totalFailed: 0,
  };

  for (const campaign of result.Items || []) {
    if (campaign.stats) {
      aggregated.totalSent += campaign.stats.totalSent || 0;
      aggregated.totalDelivered += campaign.stats.totalDelivered || 0;
      aggregated.totalFailed += campaign.stats.totalFailed || 0;
    }
  }

  return formatResponse(200, { aggregated });
}

/**
 * Find patients matching target criteria
 */
async function findTargetedPatients(criteria: TargetCriteria): Promise<any[]> {
  const result = await docClient.send(new ScanCommand({
    TableName: PATIENT_TABLE,
    FilterExpression: 'recordType = :recordType AND attribute_not_exists(optedOut)',
    ExpressionAttributeValues: { ':recordType': 'PROFILE' },
    Limit: 1000,
  }));

  let patients = result.Items || [];

  if (criteria.lastVisitDaysAgo?.min) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - criteria.lastVisitDaysAgo.min);
    patients = patients.filter(p => {
      if (!p.lastVisit) return true;
      return new Date(p.lastVisit) < cutoff;
    });
  }

  if (criteria.hasUpcomingAppointment === false) {
    patients = patients.filter(p => !p.nextAppointment);
  }

  return patients;
}

/**
 * Send campaign message to a patient
 */
async function sendCampaignMessage(campaign: Campaign, patient: any): Promise<void> {
  if ((campaign.channel === 'sms' || campaign.channel === 'both') && patient.phoneNumber) {
    const smsMessage = applyTemplate(campaign.content.smsTemplate || '', patient);
    if (smsMessage) {
      await sendSMS(patient.phoneNumber, smsMessage);
    }
  }

  if ((campaign.channel === 'email' || campaign.channel === 'both') && patient.email) {
    const subject = applyTemplate(campaign.content.emailSubject || `Message from ${PRACTICE_NAME}`, patient);
    const body = applyTemplate(campaign.content.emailBody || '', patient);
    if (body) {
      await sendEmail(patient.email, subject, body);
    }
  }

  await docClient.send(new UpdateCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { campaignId: campaign.campaignId },
    UpdateExpression: 'SET stats.totalSent = stats.totalSent + :inc',
    ExpressionAttributeValues: { ':inc': 1 },
  }));
}

/**
 * Apply template with patient data
 */
function applyTemplate(template: string, patient: any): string {
  return template
    .replace(/\{\{firstName\}\}/g, patient.firstName || 'Patient')
    .replace(/\{\{lastName\}\}/g, patient.lastName || '')
    .replace(/\{\{practiceName\}\}/g, PRACTICE_NAME);
}

/**
 * Send email via SES
 */
async function sendEmail(email: string, subject: string, body: string): Promise<void> {
  await sesClient.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: subject },
      Body: { Text: { Data: body } },
    },
  }));
}

/**
 * Get campaign by ID
 */
async function getCampaignById(campaignId: string): Promise<Campaign | null> {
  const result = await docClient.send(new GetCommand({
    TableName: CAMPAIGNS_TABLE,
    Key: { campaignId },
  }));
  return result.Item as Campaign || null;
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
