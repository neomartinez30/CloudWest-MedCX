import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PinpointClient, SendMessagesCommand } from '@aws-sdk/client-pinpoint';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { v4 as uuidv4 } from 'uuid';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const pinpointClient = new PinpointClient({});
const eventBridge = new EventBridgeClient({});
const lambdaClient = new LambdaClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const PINPOINT_APP_ID = process.env.PINPOINT_APP_ID!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;

interface OutreachRequest {
  action: 'sendAppointmentReminders' | 'sendBulkMessage' | 'startOnboardingCampaign' | 'sendReactivation';
  patientId?: string;
  patientIds?: string[];
  reminderType?: '24_hours' | '2_hours' | '1_day';
  message?: string;
  channel?: 'sms' | 'email' | 'both';
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

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in outreach engine:', error);
    return {
      error: 'Failed to process outreach request',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
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
      interactionId: uuidv4(),
      interactionType: 'outreach',
      campaign,
      step,
      channel: 'sms',
      direction: 'outbound',
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
