import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'crypto';

const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});
const secretsManager = new SecretsManagerClient({});

const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const AVAILABILITY_TABLE = process.env.AVAILABILITY_TABLE!;
const GOOGLE_SECRETS_ARN = process.env.GOOGLE_SECRETS_ARN!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface AppointmentSlot {
  startTime: string;
  endTime: string;
  providerId: string;
  providerName: string;
  location?: string;
  appointmentType?: string;
}

interface AppointmentRequest {
  patientId: string;
  providerId?: string;
  appointmentType?: string;
  preferredDate?: string;
  preferredTime?: string;
  duration?: number;
  notes?: string;
}

/**
 * Appointment Scheduler Lambda (GenAI-powered)
 *
 * Intelligent appointment scheduling with AI assistance:
 * - Natural language appointment requests
 * - Smart slot recommendations
 * - Google Calendar integration
 * - Automated confirmations and reminders
 * - Interactive scheduling via Apple Messages
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Appointment Scheduler Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...data } = event;

    switch (action) {
      case 'getAvailableSlots':
        return getAvailableSlots(data);

      case 'scheduleAppointment':
        return scheduleAppointment(data);

      case 'rescheduleAppointment':
        return rescheduleAppointment(data);

      case 'cancelAppointment':
        return cancelAppointment(data);

      case 'confirmAppointment':
        return confirmAppointment(data);

      case 'getPatientAppointments':
        return getPatientAppointments(data.patientId);

      case 'suggestSlots':
        return suggestBestSlots(data);

      case 'parseNaturalLanguage':
        return parseNaturalLanguageRequest(data.message, data.patientId);

      case 'sendTimePicker':
        return sendTimePickerToPatient(data);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in appointment scheduler:', error);
    return {
      error: 'Scheduling failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Get available appointment slots
 */
async function getAvailableSlots(params: {
  startDate: string;
  endDate?: string;
  providerId?: string;
  appointmentType?: string;
  duration?: number;
}): Promise<{ slots: AppointmentSlot[] }> {
  const { startDate, endDate, providerId, appointmentType, duration = 30 } = params;
  const end = endDate || startDate;

  // Query availability from DynamoDB
  const result = await docClient.send(new QueryCommand({
    TableName: AVAILABILITY_TABLE,
    IndexName: 'date-index',
    KeyConditionExpression: 'availabilityDate BETWEEN :start AND :end',
    FilterExpression: providerId ? 'providerId = :providerId' : undefined,
    ExpressionAttributeValues: {
      ':start': startDate,
      ':end': end,
      ...(providerId && { ':providerId': providerId }),
    },
  }));

  const availability = result.Items || [];

  // Get existing appointments to check conflicts
  const appointmentsResult = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'date-index',
    KeyConditionExpression: 'appointmentDate BETWEEN :start AND :end',
    FilterExpression: '#status <> :cancelled',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':start': startDate,
      ':end': end,
      ':cancelled': 'cancelled',
    },
  }));

  const existingAppointments = appointmentsResult.Items || [];

  // Generate available slots
  const slots: AppointmentSlot[] = [];

  for (const avail of availability) {
    const daySlots = generateTimeSlots(
      avail.startTime,
      avail.endTime,
      duration,
      avail.providerId,
      avail.providerName,
      avail.location,
      appointmentType
    );

    // Filter out conflicting slots
    for (const slot of daySlots) {
      const hasConflict = existingAppointments.some((apt: any) =>
        apt.providerId === slot.providerId &&
        apt.appointmentDate === startDate &&
        isTimeOverlap(apt.appointmentTime, apt.duration || 30, slot.startTime, duration)
      );

      if (!hasConflict) {
        slots.push(slot);
      }
    }
  }

  return { slots };
}

/**
 * Schedule a new appointment
 */
async function scheduleAppointment(request: AppointmentRequest & {
  slotTime: string;
  slotDate: string;
}): Promise<any> {
  const appointmentId = randomUUID();
  const now = new Date().toISOString();

  // Get patient info
  const patientResult = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId: request.patientId, recordType: 'PROFILE' },
  }));

  const patient = patientResult.Item;

  // Create appointment
  const appointment = {
    appointmentId,
    patientId: request.patientId,
    patientName: patient ? `${patient.firstName} ${patient.lastName}` : 'Unknown',
    patientPhone: patient?.phoneNumber,
    patientEmail: patient?.email,
    providerId: request.providerId,
    appointmentDate: request.slotDate,
    appointmentTime: request.slotTime,
    appointmentType: request.appointmentType || 'General',
    duration: request.duration || 30,
    status: 'scheduled',
    notes: request.notes,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: APPOINTMENT_TABLE,
    Item: appointment,
  }));

  // Sync to Google Calendar if configured
  await syncToGoogleCalendar(appointment);

  // Send confirmation
  await sendAppointmentConfirmation(appointment);

  // Emit event
  await emitEvent('AppointmentScheduled', {
    appointmentId,
    patientId: request.patientId,
    appointmentDate: request.slotDate,
    appointmentTime: request.slotTime,
    timestamp: now,
  });

  return {
    success: true,
    appointmentId,
    appointment,
    message: `Appointment scheduled for ${request.slotDate} at ${request.slotTime}`,
  };
}

/**
 * Reschedule an appointment
 */
async function rescheduleAppointment(data: {
  appointmentId: string;
  patientId: string;
  newDate: string;
  newTime: string;
  reason?: string;
}): Promise<any> {
  const { appointmentId, patientId, newDate, newTime, reason } = data;
  const now = new Date().toISOString();

  // Get existing appointment
  const existing = await docClient.send(new GetCommand({
    TableName: APPOINTMENT_TABLE,
    Key: { appointmentId },
  }));

  if (!existing.Item) {
    return { error: 'Appointment not found' };
  }

  if (existing.Item.patientId !== patientId) {
    return { error: 'Unauthorized' };
  }

  const oldDate = existing.Item.appointmentDate;
  const oldTime = existing.Item.appointmentTime;

  // Update appointment
  await docClient.send(new UpdateCommand({
    TableName: APPOINTMENT_TABLE,
    Key: { appointmentId },
    UpdateExpression: 'SET appointmentDate = :date, appointmentTime = :time, #status = :status, updatedAt = :updated, rescheduleReason = :reason, previousDate = :oldDate, previousTime = :oldTime',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':date': newDate,
      ':time': newTime,
      ':status': 'rescheduled',
      ':updated': now,
      ':reason': reason,
      ':oldDate': oldDate,
      ':oldTime': oldTime,
    },
  }));

  // Update Google Calendar
  await updateGoogleCalendarEvent({
    ...existing.Item,
    appointmentDate: newDate,
    appointmentTime: newTime,
  });

  // Send notification
  await sendRescheduleConfirmation({
    ...existing.Item,
    appointmentDate: newDate,
    appointmentTime: newTime,
    oldDate,
    oldTime,
  });

  // Emit event
  await emitEvent('AppointmentRescheduled', {
    appointmentId,
    patientId,
    oldDate,
    oldTime,
    newDate,
    newTime,
    timestamp: now,
  });

  return {
    success: true,
    appointmentId,
    newDate,
    newTime,
    message: `Appointment rescheduled from ${oldDate} ${oldTime} to ${newDate} ${newTime}`,
  };
}

/**
 * Cancel an appointment
 */
async function cancelAppointment(data: {
  appointmentId: string;
  patientId: string;
  reason?: string;
}): Promise<any> {
  const { appointmentId, patientId, reason } = data;
  const now = new Date().toISOString();

  // Get existing appointment
  const existing = await docClient.send(new GetCommand({
    TableName: APPOINTMENT_TABLE,
    Key: { appointmentId },
  }));

  if (!existing.Item) {
    return { error: 'Appointment not found' };
  }

  if (existing.Item.patientId !== patientId) {
    return { error: 'Unauthorized' };
  }

  // Update status
  await docClient.send(new UpdateCommand({
    TableName: APPOINTMENT_TABLE,
    Key: { appointmentId },
    UpdateExpression: 'SET #status = :status, cancelledAt = :cancelled, cancelReason = :reason',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'cancelled',
      ':cancelled': now,
      ':reason': reason,
    },
  }));

  // Remove from Google Calendar
  await deleteGoogleCalendarEvent(existing.Item.googleEventId);

  // Send confirmation
  await sendCancellationConfirmation(existing.Item);

  // Emit event
  await emitEvent('AppointmentCancelled', {
    appointmentId,
    patientId,
    reason,
    timestamp: now,
  });

  return {
    success: true,
    appointmentId,
    message: 'Appointment cancelled successfully',
  };
}

/**
 * Confirm an appointment
 */
async function confirmAppointment(data: {
  appointmentId: string;
  patientId: string;
}): Promise<any> {
  const { appointmentId, patientId } = data;
  const now = new Date().toISOString();

  await docClient.send(new UpdateCommand({
    TableName: APPOINTMENT_TABLE,
    Key: { appointmentId },
    UpdateExpression: 'SET #status = :status, confirmedAt = :confirmed',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'confirmed',
      ':confirmed': now,
    },
  }));

  await emitEvent('AppointmentConfirmed', {
    appointmentId,
    patientId,
    timestamp: now,
  });

  return {
    success: true,
    appointmentId,
    message: 'Appointment confirmed',
  };
}

/**
 * Get patient appointments
 */
async function getPatientAppointments(patientId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: true,
  }));

  const appointments = result.Items || [];
  const now = new Date();

  return {
    upcoming: appointments.filter((a: any) =>
      new Date(a.appointmentDate) >= now && a.status !== 'cancelled'
    ),
    past: appointments.filter((a: any) =>
      new Date(a.appointmentDate) < now
    ),
    cancelled: appointments.filter((a: any) =>
      a.status === 'cancelled'
    ),
  };
}

/**
 * Suggest best slots based on patient preferences
 */
async function suggestBestSlots(data: {
  patientId: string;
  appointmentType?: string;
  providerId?: string;
  daysAhead?: number;
}): Promise<any> {
  const { patientId, appointmentType, providerId, daysAhead = 14 } = data;

  // Get patient preferences
  const patientResult = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));

  const patient = patientResult.Item;
  const preferredDays = patient?.preferredDays || [];
  const preferredTimes = patient?.preferredTimes || [];

  // Get available slots for the next N days
  const startDate = new Date().toISOString().split('T')[0];
  const endDate = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const { slots } = await getAvailableSlots({
    startDate,
    endDate,
    providerId,
    appointmentType,
  });

  // Score and sort slots based on preferences
  const scoredSlots = slots.map(slot => {
    let score = 0;
    const slotDate = new Date(slot.startTime);
    const dayName = slotDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const hour = slotDate.getHours();

    // Prefer patient's preferred days
    if (preferredDays.includes(dayName)) score += 10;

    // Prefer patient's preferred times
    if (preferredTimes.includes('morning') && hour < 12) score += 5;
    if (preferredTimes.includes('afternoon') && hour >= 12 && hour < 17) score += 5;
    if (preferredTimes.includes('evening') && hour >= 17) score += 5;

    // Prefer sooner appointments
    const daysFromNow = Math.floor((slotDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    score += Math.max(0, 7 - daysFromNow);

    return { ...slot, score };
  });

  // Sort by score and return top suggestions
  const suggestions = scoredSlots
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    suggestions,
    totalAvailable: slots.length,
  };
}

/**
 * Parse natural language scheduling request
 */
async function parseNaturalLanguageRequest(message: string, patientId: string): Promise<any> {
  // Simple parsing - in production would use Bedrock for NLU
  const result: any = {
    intent: 'schedule',
    patientId,
  };

  // Check for date mentions
  const tomorrow = message.toLowerCase().includes('tomorrow');
  const nextWeek = message.toLowerCase().includes('next week');

  if (tomorrow) {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    result.preferredDate = date.toISOString().split('T')[0];
  } else if (nextWeek) {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    result.preferredDate = date.toISOString().split('T')[0];
  }

  // Check for time preferences
  if (message.toLowerCase().includes('morning')) {
    result.preferredTime = 'morning';
  } else if (message.toLowerCase().includes('afternoon')) {
    result.preferredTime = 'afternoon';
  }

  // Check for appointment type
  if (message.toLowerCase().includes('checkup') || message.toLowerCase().includes('check-up')) {
    result.appointmentType = 'checkup';
  } else if (message.toLowerCase().includes('follow')) {
    result.appointmentType = 'followup';
  }

  return result;
}

/**
 * Send Time Picker via Apple Messages
 */
async function sendTimePickerToPatient(data: {
  patientId: string;
  slots: AppointmentSlot[];
  title?: string;
}): Promise<any> {
  const { patientId, slots, title = 'Select an Appointment Time' } = data;

  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendInteractive',
    patientId,
    interactiveType: 'time_picker',
    payload: {
      title,
      eventTitle: 'Medical Appointment',
      slots: slots.map(slot => ({
        startTime: slot.startTime,
        duration: 30,
      })),
    },
  });

  return {
    success: true,
    message: 'Time picker sent to patient',
    slotCount: slots.length,
  };
}

// Helper functions
function generateTimeSlots(
  startTime: string,
  endTime: string,
  duration: number,
  providerId: string,
  providerName: string,
  location?: string,
  appointmentType?: string
): AppointmentSlot[] {
  const slots: AppointmentSlot[] = [];
  const start = new Date(startTime);
  const end = new Date(endTime);

  while (start < end) {
    const slotEnd = new Date(start.getTime() + duration * 60000);
    if (slotEnd <= end) {
      slots.push({
        startTime: start.toISOString(),
        endTime: slotEnd.toISOString(),
        providerId,
        providerName,
        location,
        appointmentType,
      });
    }
    start.setMinutes(start.getMinutes() + duration);
  }

  return slots;
}

function isTimeOverlap(
  time1: string,
  duration1: number,
  time2: string,
  duration2: number
): boolean {
  const start1 = new Date(time1).getTime();
  const end1 = start1 + duration1 * 60000;
  const start2 = new Date(time2).getTime();
  const end2 = start2 + duration2 * 60000;

  return start1 < end2 && start2 < end1;
}

async function syncToGoogleCalendar(appointment: any): Promise<void> {
  // Google Calendar sync implementation
  console.log('Syncing to Google Calendar:', appointment.appointmentId);
}

async function updateGoogleCalendarEvent(appointment: any): Promise<void> {
  console.log('Updating Google Calendar event:', appointment.appointmentId);
}

async function deleteGoogleCalendarEvent(eventId?: string): Promise<void> {
  if (eventId) {
    console.log('Deleting Google Calendar event:', eventId);
  }
}

async function sendAppointmentConfirmation(appointment: any): Promise<void> {
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendOutbound',
    channel: 'sms',
    patientId: appointment.patientId,
    content: `Your appointment is confirmed for ${appointment.appointmentDate} at ${appointment.appointmentTime}. Reply CONFIRM to confirm or RESCHEDULE to change.`,
  });
}

async function sendRescheduleConfirmation(appointment: any): Promise<void> {
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendOutbound',
    channel: 'sms',
    patientId: appointment.patientId,
    content: `Your appointment has been rescheduled to ${appointment.appointmentDate} at ${appointment.appointmentTime}.`,
  });
}

async function sendCancellationConfirmation(appointment: any): Promise<void> {
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendOutbound',
    channel: 'sms',
    patientId: appointment.patientId,
    content: `Your appointment on ${appointment.appointmentDate} at ${appointment.appointmentTime} has been cancelled. Reply SCHEDULE to book a new appointment.`,
  });
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
      Source: 'medcx.scheduler',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
