import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PinpointClient, SendMessagesCommand } from '@aws-sdk/client-pinpoint';
import { randomUUID } from 'crypto';

const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const pinpointClient = new PinpointClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const PINPOINT_APP_ID = process.env.PINPOINT_APP_ID!;
const APPOINTMENT_SCHEDULER_ARN = process.env.APPOINTMENT_SCHEDULER_ARN!;
const BEDROCK_FUNCTION_ARN = process.env.BEDROCK_FUNCTION_ARN!;
const IDENTITY_RESOLVER_ARN = process.env.IDENTITY_RESOLVER_ARN!;

interface LexEvent {
  sessionState: {
    sessionAttributes?: Record<string, string>;
    intent: {
      name: string;
      slots: Record<string, any>;
      state: string;
      confirmationState?: string;
    };
    dialogAction?: {
      type: string;
    };
  };
  invocationSource: string;
  inputTranscript: string;
  interpretations: any[];
  requestAttributes?: Record<string, string>;
  bot: {
    id: string;
    name: string;
    aliasId: string;
    aliasName: string;
    localeId: string;
    version: string;
  };
  sessionId: string;
}

/**
 * Lex Fulfillment Lambda
 *
 * Handles Lex bot fulfillment for the appointment scheduling bot.
 * Integrates with Bedrock for natural language understanding and
 * supports interactive messaging for rich channel experiences.
 */
export const handler = async (event: LexEvent): Promise<any> => {
  console.log('Lex Fulfillment Event:', JSON.stringify(event, null, 2));

  try {
    const intentName = event.sessionState.intent.name;
    const slots = event.sessionState.intent.slots;
    const sessionAttributes = event.sessionState.sessionAttributes || {};
    const invocationSource = event.invocationSource;

    // Get or resolve patient identity
    let patientId = sessionAttributes.patientId;
    if (!patientId) {
      const phoneNumber = sessionAttributes.phoneNumber || event.requestAttributes?.['x-amz-lex:caller-id'];
      if (phoneNumber) {
        const identity = await resolvePatientIdentity(phoneNumber);
        if (identity) {
          patientId = identity.patientId;
          sessionAttributes.patientId = patientId;
          sessionAttributes.patientName = `${identity.firstName || ''} ${identity.lastName || ''}`.trim();
        }
      }
    }

    // Route to appropriate handler
    switch (intentName) {
      case 'ScheduleAppointment':
        return handleScheduleAppointment(event, slots, sessionAttributes, invocationSource);

      case 'CheckAppointments':
        return handleCheckAppointments(event, sessionAttributes);

      case 'CancelAppointment':
        return handleCancelAppointment(event, slots, sessionAttributes);

      case 'RescheduleAppointment':
        return handleRescheduleAppointment(event, slots, sessionAttributes);

      case 'SendTimesViaSMS':
        return handleSendTimesViaSMS(event, sessionAttributes);

      case 'Help':
        return handleHelp(event, sessionAttributes);

      case 'FallbackIntent':
        return handleFallback(event, sessionAttributes);

      default:
        return buildResponse(event, 'Close', 'Fulfilled',
          "I'm not sure how to help with that. Would you like to schedule an appointment or speak with an agent?");
    }
  } catch (error) {
    console.error('Error in Lex fulfillment:', error);
    return buildResponse(event, 'Close', 'Failed',
      "I'm sorry, I encountered an error. Let me connect you with an agent who can help.");
  }
};

/**
 * Handle Schedule Appointment intent
 */
async function handleScheduleAppointment(
  event: LexEvent,
  slots: Record<string, any>,
  sessionAttributes: Record<string, string>,
  invocationSource: string
): Promise<any> {
  const appointmentType = getSlotValue(slots.AppointmentType);
  const appointmentDate = getSlotValue(slots.AppointmentDate);
  const appointmentTime = getSlotValue(slots.AppointmentTime);

  // If dialog code hook, validate slots
  if (invocationSource === 'DialogCodeHook') {
    // Check if all required slots are filled
    if (!appointmentType) {
      return buildElicitSlotResponse(event, 'AppointmentType',
        "What type of appointment do you need? For example: general checkup, follow-up, or urgent care.");
    }

    if (!appointmentDate) {
      return buildElicitSlotResponse(event, 'AppointmentDate',
        "What date works best for you? I can also send you available times via text message.");
    }

    if (!appointmentTime) {
      // Offer to send times via SMS
      const message = `I have several times available on ${appointmentDate}. Would you like me to text you the available slots so you can choose easily?`;
      return buildConfirmIntentResponse(event, message, sessionAttributes);
    }

    // All slots filled, proceed to confirmation
    return buildConfirmIntentResponse(event,
      `Perfect! I have you down for a ${appointmentType} appointment on ${appointmentDate} at ${appointmentTime}. Shall I confirm this?`,
      sessionAttributes);
  }

  // Fulfillment - actually book the appointment
  if (!sessionAttributes.patientId) {
    return buildResponse(event, 'Close', 'Failed',
      "I couldn't find your patient record. Please provide your phone number or contact us directly.");
  }

  // Check confirmation
  if (event.sessionState.intent.confirmationState === 'Denied') {
    return buildResponse(event, 'Close', 'Failed',
      "No problem! Let me know when you'd like to reschedule.");
  }

  // Book the appointment
  const bookingResult = await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
    action: 'bookAppointment',
    patientId: sessionAttributes.patientId,
    appointmentType,
    preferredDate: appointmentDate,
    preferredTime: appointmentTime,
    sendCalendarInvite: true,
  });

  if (bookingResult.success) {
    const confirmationMessage = `Your ${appointmentType} appointment is confirmed for ${appointmentDate} at ${appointmentTime}. ` +
      `I've sent a calendar invitation to your email. Is there anything else I can help you with?`;

    // Store the appointment in conversation context
    await recordConversation(sessionAttributes.patientId, 'outbound', confirmationMessage, 'appointment_confirmation');

    return buildResponse(event, 'Close', 'Fulfilled', confirmationMessage);
  } else {
    return buildResponse(event, 'Close', 'Failed',
      "I couldn't complete the booking. That time slot may no longer be available. Would you like to try a different time?");
  }
}

/**
 * Handle Check Appointments intent
 */
async function handleCheckAppointments(
  event: LexEvent,
  sessionAttributes: Record<string, string>
): Promise<any> {
  if (!sessionAttributes.patientId) {
    return buildResponse(event, 'Close', 'Failed',
      "I couldn't find your patient record. Please provide your phone number so I can look up your appointments.");
  }

  const appointments = await getUpcomingAppointments(sessionAttributes.patientId);

  if (appointments.length === 0) {
    return buildResponse(event, 'Close', 'Fulfilled',
      "You don't have any upcoming appointments. Would you like to schedule one?");
  }

  let message = "Here are your upcoming appointments:\n";
  appointments.slice(0, 3).forEach((apt, index) => {
    message += `${index + 1}. ${apt.appointmentType} on ${apt.appointmentDate} at ${apt.appointmentTime}\n`;
  });

  if (appointments.length > 3) {
    message += `And ${appointments.length - 3} more. `;
  }

  message += "\nWould you like to reschedule or cancel any of these?";

  return buildResponse(event, 'Close', 'Fulfilled', message);
}

/**
 * Handle Cancel Appointment intent
 */
async function handleCancelAppointment(
  event: LexEvent,
  slots: Record<string, any>,
  sessionAttributes: Record<string, string>
): Promise<any> {
  if (!sessionAttributes.patientId) {
    return buildResponse(event, 'Close', 'Failed',
      "I couldn't find your patient record. Please provide your phone number.");
  }

  const appointmentDate = getSlotValue(slots.AppointmentDate);

  // Find appointments on the given date
  const appointments = await getUpcomingAppointments(sessionAttributes.patientId);
  const matchingAppointments = appointmentDate
    ? appointments.filter(a => a.appointmentDate === appointmentDate)
    : appointments;

  if (matchingAppointments.length === 0) {
    return buildResponse(event, 'Close', 'Failed',
      "I couldn't find any appointments to cancel. Would you like to check your appointments?");
  }

  if (matchingAppointments.length === 1) {
    // Cancel the only matching appointment
    const apt = matchingAppointments[0];
    const result = await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
      action: 'cancel',
      appointmentId: apt.appointmentId,
    });

    if (result.success) {
      return buildResponse(event, 'Close', 'Fulfilled',
        `I've cancelled your ${apt.appointmentType} appointment on ${apt.appointmentDate}. Would you like to reschedule?`);
    }
  }

  // Multiple appointments - ask for clarification
  let message = "Which appointment would you like to cancel?\n";
  matchingAppointments.forEach((apt, index) => {
    message += `${index + 1}. ${apt.appointmentType} on ${apt.appointmentDate} at ${apt.appointmentTime}\n`;
  });

  return buildElicitSlotResponse(event, 'AppointmentDate', message);
}

/**
 * Handle Reschedule Appointment intent
 */
async function handleRescheduleAppointment(
  event: LexEvent,
  slots: Record<string, any>,
  sessionAttributes: Record<string, string>
): Promise<any> {
  const newDate = getSlotValue(slots.NewDate);
  const newTime = getSlotValue(slots.NewTime);

  if (!sessionAttributes.patientId) {
    return buildResponse(event, 'Close', 'Failed',
      "I couldn't find your patient record. Please provide your phone number.");
  }

  if (!newDate || !newTime) {
    return buildElicitSlotResponse(event, newDate ? 'NewTime' : 'NewDate',
      "When would you like to reschedule to?");
  }

  // Get the most recent appointment to reschedule
  const appointments = await getUpcomingAppointments(sessionAttributes.patientId);
  if (appointments.length === 0) {
    return buildResponse(event, 'Close', 'Failed',
      "You don't have any appointments to reschedule.");
  }

  const result = await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
    action: 'reschedule',
    appointmentId: appointments[0].appointmentId,
    preferredDate: newDate,
    preferredTime: newTime,
  });

  if (result.success) {
    return buildResponse(event, 'Close', 'Fulfilled',
      `Done! Your appointment has been rescheduled to ${newDate} at ${newTime}. I've updated your calendar invitation.`);
  }

  return buildResponse(event, 'Close', 'Failed',
    "I couldn't reschedule to that time. Would you like to try a different time?");
}

/**
 * Handle Send Times via SMS
 */
async function handleSendTimesViaSMS(
  event: LexEvent,
  sessionAttributes: Record<string, string>
): Promise<any> {
  if (!sessionAttributes.patientId) {
    return buildResponse(event, 'Close', 'Failed',
      "I couldn't find your phone number to send the times.");
  }

  // Get patient phone number
  const patient = await getPatient(sessionAttributes.patientId);
  if (!patient || !patient.phoneNumber) {
    return buildResponse(event, 'Close', 'Failed',
      "I don't have a phone number on file. Could you provide one?");
  }

  // Get available slots
  const slotsResult = await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
    action: 'getAvailableSlots',
    preferredDate: new Date().toISOString().split('T')[0],
  });

  if (!slotsResult.slots || slotsResult.slots.length === 0) {
    return buildResponse(event, 'Close', 'Failed',
      "I couldn't find any available slots. Please try again or speak with an agent.");
  }

  // Format slots for SMS
  const topSlots = slotsResult.slots.slice(0, 5);
  let smsMessage = "Available appointment times:\n";
  topSlots.forEach((slot: any, index: number) => {
    const date = new Date(slot.startTime);
    smsMessage += `${index + 1}. ${date.toLocaleDateString()} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n`;
  });
  smsMessage += "\nReply with the number to book, or say 'more' for additional times.";

  // Send SMS
  await sendSMS(patient.phoneNumber, smsMessage);

  // Store context for follow-up
  await recordConversation(sessionAttributes.patientId, 'outbound', smsMessage, 'available_times');

  return buildResponse(event, 'Close', 'Fulfilled',
    "I've sent the available times to your phone. You can reply to that message to book, or continue here. Is there anything else I can help with?");
}

/**
 * Handle Help intent
 */
async function handleHelp(
  event: LexEvent,
  sessionAttributes: Record<string, string>
): Promise<any> {
  const helpMessage = `I can help you with:
- Schedule a new appointment
- Check your upcoming appointments
- Cancel or reschedule appointments
- Send available times to your phone

Just tell me what you'd like to do, or say "speak to an agent" if you need additional help.`;

  return buildResponse(event, 'Close', 'Fulfilled', helpMessage);
}

/**
 * Handle Fallback intent using Bedrock
 */
async function handleFallback(
  event: LexEvent,
  sessionAttributes: Record<string, string>
): Promise<any> {
  const userMessage = event.inputTranscript;

  // Use Bedrock for natural language understanding
  const bedrockResult = await invokeFunction(BEDROCK_FUNCTION_ARN, {
    action: 'generateResponse',
    patientId: sessionAttributes.patientId,
    userMessage,
    context: sessionAttributes,
  });

  if (bedrockResult.response) {
    return buildResponse(event, 'Close', 'Fulfilled', bedrockResult.response);
  }

  return buildResponse(event, 'Close', 'Fulfilled',
    "I'm not sure I understood that. Would you like to schedule an appointment, or would you prefer to speak with an agent?");
}

// ============================================================================
// Helper Functions
// ============================================================================

function getSlotValue(slot: any): string | null {
  if (!slot) return null;
  return slot.value?.interpretedValue || slot.value?.originalValue || null;
}

function buildResponse(
  event: LexEvent,
  dialogActionType: string,
  fulfillmentState: string,
  message: string
): any {
  return {
    sessionState: {
      sessionAttributes: event.sessionState.sessionAttributes,
      dialogAction: {
        type: dialogActionType,
      },
      intent: {
        ...event.sessionState.intent,
        state: fulfillmentState,
      },
    },
    messages: [
      {
        contentType: 'PlainText',
        content: message,
      },
    ],
  };
}

function buildElicitSlotResponse(
  event: LexEvent,
  slotToElicit: string,
  message: string
): any {
  return {
    sessionState: {
      sessionAttributes: event.sessionState.sessionAttributes,
      dialogAction: {
        type: 'ElicitSlot',
        slotToElicit,
      },
      intent: event.sessionState.intent,
    },
    messages: [
      {
        contentType: 'PlainText',
        content: message,
      },
    ],
  };
}

function buildConfirmIntentResponse(
  event: LexEvent,
  message: string,
  sessionAttributes: Record<string, string>
): any {
  return {
    sessionState: {
      sessionAttributes,
      dialogAction: {
        type: 'ConfirmIntent',
      },
      intent: event.sessionState.intent,
    },
    messages: [
      {
        contentType: 'PlainText',
        content: message,
      },
    ],
  };
}

async function invokeFunction(functionArn: string, payload: any): Promise<any> {
  const command = new InvokeCommand({
    FunctionName: functionArn,
    Payload: JSON.stringify(payload),
  });

  const response = await lambdaClient.send(command);
  return JSON.parse(new TextDecoder().decode(response.Payload));
}

async function resolvePatientIdentity(phoneNumber: string): Promise<any> {
  return invokeFunction(IDENTITY_RESOLVER_ARN, {
    phoneNumber,
    createIfNotFound: false,
  });
}

async function getPatient(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));
  return result.Item;
}

async function getUpcomingAppointments(patientId: string): Promise<any[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId AND appointmentDateTime >= :now',
    ExpressionAttributeValues: {
      ':patientId': patientId,
      ':now': new Date().toISOString(),
    },
    Limit: 10,
  }));
  return result.Items || [];
}

async function recordConversation(
  patientId: string,
  direction: string,
  content: string,
  messageType: string
): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: CONVERSATION_TABLE,
    Item: {
      patientId,
      messageTimestamp: new Date().toISOString(),
      messageId: randomUUID(),
      direction,
      content,
      messageType,
      channel: 'voice',
      createdAt: new Date().toISOString(),
    },
  }));
}

async function sendSMS(phoneNumber: string, message: string): Promise<void> {
  await pinpointClient.send(new SendMessagesCommand({
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
  }));
}
