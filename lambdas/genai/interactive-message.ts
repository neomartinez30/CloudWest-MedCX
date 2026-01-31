import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});

const INTERACTIVE_MESSAGE_TABLE = process.env.INTERACTIVE_MESSAGE_TABLE!;
const APPLE_HANDLER_ARN = process.env.APPLE_HANDLER_ARN!;
const APPOINTMENT_SCHEDULER_ARN = process.env.APPOINTMENT_SCHEDULER_ARN!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

type InteractiveType = 'time_picker' | 'list_picker' | 'rich_link' | 'quick_replies' | 'form';

interface InteractiveMessageRequest {
  patientId: string;
  type: InteractiveType;
  payload: any;
  channel?: string;
  expiresIn?: number; // minutes
}

/**
 * Interactive Message Lambda
 *
 * Manages interactive message flows:
 * - Build and send Time Pickers for scheduling
 * - Create List Pickers for service selection
 * - Generate Rich Links for portal access
 * - Handle Quick Replies for confirmations
 * - Track and process responses
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Interactive Message Event:', JSON.stringify(event, null, 2));

  try {
    // Handle EventBridge events (responses from Apple Messages)
    if (event.source?.startsWith('medcx')) {
      return handleEventBridgeEvent(event);
    }

    const { action, ...data } = event;

    switch (action) {
      case 'sendTimePicker':
        return sendTimePicker(data);

      case 'sendListPicker':
        return sendListPicker(data);

      case 'sendRichLink':
        return sendRichLink(data);

      case 'sendQuickReplies':
        return sendQuickReplies(data);

      case 'processResponse':
        return processInteractiveResponse(data);

      case 'getMessageStatus':
        return getMessageStatus(data.messageId);

      case 'buildAppointmentPicker':
        return buildAppointmentPicker(data);

      case 'buildServiceSelector':
        return buildServiceSelector(data);

      case 'buildPaymentLink':
        return buildPaymentLink(data);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in interactive message handler:', error);
    return {
      error: 'Interactive message failed',
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
    case 'AppleInteractiveResponse':
      return processInteractiveResponse({
        messageId: detail.requestIdentifier,
        responseType: detail.interactiveType,
        responseData: detail.response,
        patientId: detail.patientId,
      });

    default:
      console.log('Unhandled event type:', detailType);
      return { handled: false };
  }
}

/**
 * Send Time Picker for appointment scheduling
 */
async function sendTimePicker(data: {
  patientId: string;
  title: string;
  subtitle?: string;
  eventTitle: string;
  slots: Array<{ startTime: string; duration?: number }>;
  appointmentType?: string;
  providerId?: string;
}): Promise<any> {
  const messageId = randomUUID();

  // Store message for tracking
  await storeInteractiveMessage({
    messageId,
    patientId: data.patientId,
    type: 'time_picker',
    payload: data,
    status: 'sent',
    context: {
      appointmentType: data.appointmentType,
      providerId: data.providerId,
    },
  });

  // Send via Apple Messages handler
  await invokeFunction(APPLE_HANDLER_ARN, {
    action: 'sendTimePicker',
    destinationId: await getPatientPhone(data.patientId),
    title: data.title,
    subtitle: data.subtitle || 'Select your preferred time',
    eventTitle: data.eventTitle,
    slots: data.slots,
    patientId: data.patientId,
  });

  return {
    success: true,
    messageId,
    type: 'time_picker',
    slotCount: data.slots.length,
  };
}

/**
 * Send List Picker for selections
 */
async function sendListPicker(data: {
  patientId: string;
  title: string;
  subtitle?: string;
  sections: Array<{
    title: string;
    items: Array<{ id: string; title: string; subtitle?: string; image?: string }>;
  }>;
  selectionType?: 'single' | 'multiple';
  context?: any;
}): Promise<any> {
  const messageId = randomUUID();

  await storeInteractiveMessage({
    messageId,
    patientId: data.patientId,
    type: 'list_picker',
    payload: data,
    status: 'sent',
    context: data.context,
  });

  await invokeFunction(APPLE_HANDLER_ARN, {
    action: 'sendListPicker',
    destinationId: await getPatientPhone(data.patientId),
    title: data.title,
    subtitle: data.subtitle,
    sections: data.sections,
    patientId: data.patientId,
  });

  return {
    success: true,
    messageId,
    type: 'list_picker',
  };
}

/**
 * Send Rich Link
 */
async function sendRichLink(data: {
  patientId: string;
  title: string;
  url: string;
  imageUrl?: string;
  context?: any;
}): Promise<any> {
  const messageId = randomUUID();

  await storeInteractiveMessage({
    messageId,
    patientId: data.patientId,
    type: 'rich_link',
    payload: data,
    status: 'sent',
    context: data.context,
  });

  await invokeFunction(APPLE_HANDLER_ARN, {
    action: 'sendRichLink',
    destinationId: await getPatientPhone(data.patientId),
    title: data.title,
    url: data.url,
    imageUrl: data.imageUrl,
    patientId: data.patientId,
  });

  return {
    success: true,
    messageId,
    type: 'rich_link',
  };
}

/**
 * Send Quick Replies
 */
async function sendQuickReplies(data: {
  patientId: string;
  title: string;
  replies: Array<{ id: string; title: string }>;
  context?: any;
}): Promise<any> {
  const messageId = randomUUID();

  await storeInteractiveMessage({
    messageId,
    patientId: data.patientId,
    type: 'quick_replies',
    payload: data,
    status: 'sent',
    context: data.context,
  });

  await invokeFunction(APPLE_HANDLER_ARN, {
    action: 'sendQuickReplies',
    destinationId: await getPatientPhone(data.patientId),
    title: data.title,
    replies: data.replies,
    patientId: data.patientId,
  });

  return {
    success: true,
    messageId,
    type: 'quick_replies',
  };
}

/**
 * Process interactive message response
 */
async function processInteractiveResponse(data: {
  messageId: string;
  responseType: string;
  responseData: any;
  patientId?: string;
}): Promise<any> {
  const { messageId, responseType, responseData } = data;

  // Get original message
  const originalMessage = await docClient.send(new GetCommand({
    TableName: INTERACTIVE_MESSAGE_TABLE,
    Key: { messageId },
  }));

  if (!originalMessage.Item) {
    return { error: 'Message not found' };
  }

  const message = originalMessage.Item;
  const patientId = data.patientId || message.patientId;

  // Update message status
  await docClient.send(new PutCommand({
    TableName: INTERACTIVE_MESSAGE_TABLE,
    Item: {
      ...message,
      status: 'responded',
      response: responseData,
      respondedAt: new Date().toISOString(),
    },
  }));

  // Process based on type
  let result;
  switch (message.type) {
    case 'time_picker':
      result = await handleTimePickerResponse(message, responseData, patientId);
      break;

    case 'list_picker':
      result = await handleListPickerResponse(message, responseData, patientId);
      break;

    case 'quick_replies':
      result = await handleQuickReplyResponse(message, responseData, patientId);
      break;

    default:
      result = { processed: true };
  }

  // Emit event
  await emitEvent('InteractiveResponseProcessed', {
    messageId,
    type: message.type,
    patientId,
    response: responseData,
    timestamp: new Date().toISOString(),
  });

  return result;
}

/**
 * Handle Time Picker response
 */
async function handleTimePickerResponse(
  message: any,
  response: any,
  patientId: string
): Promise<any> {
  const selectedTime = response.selectedTime || response.event?.selectedTime;

  if (!selectedTime) {
    return { error: 'No time selected' };
  }

  // Schedule the appointment
  const scheduleResult = await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
    action: 'scheduleAppointment',
    patientId,
    slotTime: selectedTime,
    slotDate: selectedTime.split('T')[0],
    appointmentType: message.context?.appointmentType,
    providerId: message.context?.providerId,
  });

  // Send confirmation
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendOutbound',
    channel: 'apple_messages',
    patientId,
    content: `Great! Your appointment is confirmed for ${formatDateTime(selectedTime)}. We look forward to seeing you!`,
  });

  return {
    success: true,
    appointmentScheduled: true,
    appointmentId: scheduleResult.appointmentId,
    selectedTime,
  };
}

/**
 * Handle List Picker response
 */
async function handleListPickerResponse(
  message: any,
  response: any,
  patientId: string
): Promise<any> {
  const selectedItem = response.selectedItem || response.listPicker?.selectedItem;

  if (!selectedItem) {
    return { error: 'No item selected' };
  }

  // Handle based on context
  const context = message.context || {};

  if (context.type === 'service_selection') {
    // Route to appropriate service
    return {
      success: true,
      selectedService: selectedItem.identifier || selectedItem.id,
      nextAction: 'show_availability',
    };
  }

  if (context.type === 'provider_selection') {
    // Show provider availability
    return {
      success: true,
      selectedProvider: selectedItem.identifier || selectedItem.id,
      nextAction: 'show_time_picker',
    };
  }

  return {
    success: true,
    selectedItem,
  };
}

/**
 * Handle Quick Reply response
 */
async function handleQuickReplyResponse(
  message: any,
  response: any,
  patientId: string
): Promise<any> {
  const selectedReply = response.selectedReply || response.quickReply?.selectedButton;

  if (!selectedReply) {
    return { error: 'No reply selected' };
  }

  const replyId = selectedReply.identifier || selectedReply.id;

  // Handle common quick reply patterns
  if (replyId === 'confirm' || replyId === 'yes') {
    if (message.context?.appointmentId) {
      await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
        action: 'confirmAppointment',
        appointmentId: message.context.appointmentId,
        patientId,
      });

      await invokeFunction(CHANNEL_ROUTER_ARN, {
        action: 'sendOutbound',
        channel: 'apple_messages',
        patientId,
        content: 'Your appointment has been confirmed. See you then!',
      });
    }
  }

  if (replyId === 'reschedule') {
    // Send time picker for rescheduling
    const slots = await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
      action: 'suggestSlots',
      patientId,
    });

    await sendTimePicker({
      patientId,
      title: 'Reschedule Appointment',
      subtitle: 'Select a new time',
      eventTitle: 'Medical Appointment',
      slots: slots.suggestions?.map((s: any) => ({
        startTime: s.startTime,
        duration: 30,
      })) || [],
    });
  }

  return {
    success: true,
    selectedReply: replyId,
  };
}

/**
 * Build appointment picker flow
 */
async function buildAppointmentPicker(data: {
  patientId: string;
  appointmentType?: string;
  providerId?: string;
  daysAhead?: number;
}): Promise<any> {
  const { patientId, appointmentType, providerId, daysAhead = 14 } = data;

  // Get suggested slots
  const slotsResult = await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
    action: 'suggestSlots',
    patientId,
    appointmentType,
    providerId,
    daysAhead,
  });

  const slots = slotsResult.suggestions || [];

  if (slots.length === 0) {
    return {
      success: false,
      message: 'No available slots found',
    };
  }

  // Send time picker
  return sendTimePicker({
    patientId,
    title: 'Schedule Your Appointment',
    subtitle: `We found ${slots.length} available times`,
    eventTitle: appointmentType || 'Medical Appointment',
    slots: slots.map((s: any) => ({
      startTime: s.startTime,
      duration: 30,
    })),
    appointmentType,
    providerId,
  });
}

/**
 * Build service selector
 */
async function buildServiceSelector(data: {
  patientId: string;
  services?: Array<{ id: string; name: string; description?: string; duration?: number }>;
}): Promise<any> {
  const { patientId, services } = data;

  const defaultServices = [
    { id: 'checkup', name: 'Annual Checkup', description: '45 min', duration: 45 },
    { id: 'followup', name: 'Follow-up Visit', description: '30 min', duration: 30 },
    { id: 'sick', name: 'Sick Visit', description: '20 min', duration: 20 },
    { id: 'specialist', name: 'Specialist Consultation', description: '60 min', duration: 60 },
  ];

  const serviceList = services || defaultServices;

  return sendListPicker({
    patientId,
    title: 'Select Service Type',
    subtitle: 'Choose the type of appointment you need',
    sections: [{
      title: 'Available Services',
      items: serviceList.map(s => ({
        id: s.id,
        title: s.name,
        subtitle: s.description,
      })),
    }],
    context: { type: 'service_selection' },
  });
}

/**
 * Build payment link
 */
async function buildPaymentLink(data: {
  patientId: string;
  amount: number;
  description: string;
  paymentId: string;
}): Promise<any> {
  const { patientId, amount, description, paymentId } = data;

  const paymentUrl = `${process.env.PORTAL_URL}/pay/${paymentId}`;

  return sendRichLink({
    patientId,
    title: `Pay ${formatCurrency(amount)} - ${description}`,
    url: paymentUrl,
    imageUrl: `${process.env.PORTAL_URL}/images/payment-card.png`,
    context: { type: 'payment', paymentId, amount },
  });
}

/**
 * Get message status
 */
async function getMessageStatus(messageId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: INTERACTIVE_MESSAGE_TABLE,
    Key: { messageId },
  }));

  return result.Item || { error: 'Message not found' };
}

// Helper functions
async function storeInteractiveMessage(data: {
  messageId: string;
  patientId: string;
  type: InteractiveType;
  payload: any;
  status: string;
  context?: any;
}): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: INTERACTIVE_MESSAGE_TABLE,
    Item: {
      ...data,
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 days
    },
  }));
}

async function getPatientPhone(patientId: string): Promise<string> {
  // This would fetch from patient table - simplified for now
  return patientId; // In production, lookup phone from patient record
}

function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
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
      Source: 'medcx.interactive',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
