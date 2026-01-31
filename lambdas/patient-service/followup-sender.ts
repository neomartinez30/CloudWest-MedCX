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
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

/**
 * Follow-up message types
 */
type FollowupType =
  | 'POST_APPOINTMENT'
  | 'APPOINTMENT_REMINDER'
  | 'CARE_CHECK_IN'
  | 'PRESCRIPTION_REMINDER'
  | 'WELLNESS_CHECK'
  | 'SATISFACTION_SURVEY'
  | 'PAYMENT_REMINDER';

interface FollowupInput {
  patientId: string;
  followupType: FollowupType;
  appointmentId?: string;
  retryCount?: number;
  customMessage?: string;
  scheduledTime?: string;
  metadata?: Record<string, any>;
}

interface FollowupResult {
  success: boolean;
  messageId?: string;
  channel: string;
  patientId: string;
  followupType: FollowupType;
  retryCount: number;
  sentAt: string;
  error?: string;
}

/**
 * Care Follow-up Sender Lambda Handler
 *
 * This function sends follow-up messages to patients based on various triggers:
 * - Post-appointment follow-ups
 * - Appointment reminders
 * - Care check-ins
 * - Prescription reminders
 * - Wellness checks
 * - Satisfaction surveys
 *
 * It respects patient preferences for channel and timing.
 */
export const handler = async (event: any): Promise<FollowupResult> => {
  console.log('Followup Sender Event:', JSON.stringify(event, null, 2));

  try {
    // Parse input from Step Functions or direct invocation
    const input: FollowupInput = event.Payload || event;
    const {
      patientId,
      followupType,
      appointmentId,
      retryCount = 0,
      customMessage,
      metadata,
    } = input;

    // Get patient profile
    const patient = await getPatientProfile(patientId);
    if (!patient) {
      return {
        success: false,
        channel: 'unknown',
        patientId,
        followupType,
        retryCount,
        sentAt: new Date().toISOString(),
        error: 'Patient not found',
      };
    }

    // Check consent status
    if (!patient.consentStatus?.smsConsent && patient.preferredChannel === 'sms') {
      console.log('Patient has not consented to SMS communications');
      return {
        success: false,
        channel: patient.preferredChannel || 'sms',
        patientId,
        followupType,
        retryCount,
        sentAt: new Date().toISOString(),
        error: 'No SMS consent',
      };
    }

    // Get appointment details if applicable
    let appointmentDetails;
    if (appointmentId) {
      appointmentDetails = await getAppointmentDetails(appointmentId);
    }

    // Build the message based on followup type
    const message = buildFollowupMessage(followupType, patient, appointmentDetails, customMessage);

    // Determine the best channel
    const channel = determineChannel(patient, followupType);

    // Create conversation record
    const messageId = await createConversationMessage(patientId, message, channel, followupType);

    // Emit event to trigger actual message sending via Pinpoint/Connect
    await emitFollowupEvent(patientId, messageId, channel, message, followupType, metadata);

    // Record the interaction
    await recordInteraction(patientId, followupType, messageId, channel);

    return {
      success: true,
      messageId,
      channel,
      patientId,
      followupType,
      retryCount: retryCount + 1,
      sentAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error sending followup:', error);

    const input: FollowupInput = event.Payload || event;
    return {
      success: false,
      channel: 'unknown',
      patientId: input.patientId,
      followupType: input.followupType,
      retryCount: input.retryCount || 0,
      sentAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Get patient profile from DynamoDB
 */
async function getPatientProfile(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: {
      patientId,
      recordType: 'PROFILE',
    },
  }));

  return result.Item;
}

/**
 * Get appointment details
 */
async function getAppointmentDetails(appointmentId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: process.env.APPOINTMENT_TABLE!,
    Key: {
      appointmentId,
    },
  }));

  return result.Item;
}

/**
 * Build followup message based on type and patient context
 */
function buildFollowupMessage(
  followupType: FollowupType,
  patient: any,
  appointment: any,
  customMessage?: string
): string {
  const firstName = patient.firstName || 'there';

  if (customMessage) {
    return customMessage.replace('{firstName}', firstName);
  }

  switch (followupType) {
    case 'POST_APPOINTMENT':
      return `Hi ${firstName}, thank you for your recent visit with CloudWest Medical. ` +
        `We hope you're feeling well! If you have any questions about your care or treatment, ` +
        `please reply to this message or call us at (555) 123-4567. ` +
        `How are you feeling today? Reply: 1 for Great, 2 for Good, 3 for Need Help`;

    case 'APPOINTMENT_REMINDER':
      const apptDate = appointment?.appointmentDateTime
        ? new Date(appointment.appointmentDateTime).toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : 'your upcoming appointment';
      return `Hi ${firstName}, this is a reminder about ${apptDate} at CloudWest Medical. ` +
        `Reply CONFIRM to confirm, RESCHEDULE to change your appointment, or CANCEL to cancel.`;

    case 'CARE_CHECK_IN':
      return `Hi ${firstName}, this is CloudWest Medical checking in on you. ` +
        `How are you feeling today? Reply: 1 for Great, 2 for Good, 3 for Same, 4 for Worse, 5 for Need Help`;

    case 'PRESCRIPTION_REMINDER':
      return `Hi ${firstName}, this is a reminder from CloudWest Medical. ` +
        `Have you been able to pick up your prescription? Reply YES or NO. ` +
        `If you need help with refills, reply REFILL.`;

    case 'WELLNESS_CHECK':
      return `Hi ${firstName}, CloudWest Medical cares about your wellness! ` +
        `It's been a while since your last visit. Would you like to schedule a wellness check? ` +
        `Reply YES to schedule or NO THANKS.`;

    case 'SATISFACTION_SURVEY':
      return `Hi ${firstName}, thank you for choosing CloudWest Medical! ` +
        `We'd love your feedback. On a scale of 1-5, how would you rate your recent experience? ` +
        `Reply with a number from 1 (poor) to 5 (excellent).`;

    case 'PAYMENT_REMINDER':
      return `Hi ${firstName}, this is a friendly reminder from CloudWest Medical. ` +
        `You have an outstanding balance. To pay now, reply PAY or visit our patient portal. ` +
        `Need to discuss payment options? Reply HELP.`;

    default:
      return `Hi ${firstName}, this is CloudWest Medical. Please reply if you have any questions about your care.`;
  }
}

/**
 * Determine the best channel for communication
 */
function determineChannel(patient: any, followupType: FollowupType): string {
  // Respect patient preference
  const preferred = patient.preferredChannel || 'sms';

  // For urgent matters, prefer phone
  if (followupType === 'CARE_CHECK_IN' && patient.lastResponse === 'NEED_HELP') {
    return 'phone';
  }

  // For payment reminders, use the preferred channel but can escalate
  if (followupType === 'PAYMENT_REMINDER') {
    return preferred;
  }

  return preferred;
}

/**
 * Create a conversation message record
 */
async function createConversationMessage(
  patientId: string,
  message: string,
  channel: string,
  followupType: FollowupType
): Promise<string> {
  const messageId = uuidv4();
  const threadId = `followup-${patientId}-${Date.now()}`;
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: CONVERSATION_TABLE,
    Item: {
      patientId,
      messageTimestamp: now,
      messageId,
      threadId,
      channel,
      direction: 'OUTBOUND',
      messageType: 'FOLLOWUP',
      followupType,
      content: message,
      status: 'PENDING',
      createdAt: now,
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 days TTL
    },
  }));

  return messageId;
}

/**
 * Emit event to trigger message sending
 */
async function emitFollowupEvent(
  patientId: string,
  messageId: string,
  channel: string,
  message: string,
  followupType: FollowupType,
  metadata?: Record<string, any>
): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [
      {
        EventBusName: EVENT_BUS_NAME,
        Source: 'medcx.followups',
        DetailType: 'FollowupMessageReady',
        Detail: JSON.stringify({
          patientId,
          messageId,
          channel,
          message,
          followupType,
          metadata,
          timestamp: new Date().toISOString(),
        }),
      },
    ],
  }));
}

/**
 * Record interaction in patient history
 */
async function recordInteraction(
  patientId: string,
  followupType: FollowupType,
  messageId: string,
  channel: string
): Promise<void> {
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: process.env.INTERACTION_TABLE!,
    Item: {
      patientId,
      interactionTimestamp: now,
      interactionId: uuidv4(),
      interactionType: 'OUTREACH',
      subType: followupType,
      messageId,
      channel,
      status: 'SENT',
      createdAt: now,
    },
  }));
}
