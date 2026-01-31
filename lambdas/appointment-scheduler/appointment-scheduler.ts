import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { google, calendar_v3 } from 'googleapis';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});
const secretsManager = new SecretsManagerClient({});

const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const GOOGLE_SECRET_NAME = process.env.GOOGLE_SECRET_NAME!;

interface AppointmentRequest {
  action: 'getAvailableSlots' | 'bookAppointment' | 'reschedule' | 'cancel' | 'getAppointment';
  patientId?: string;
  appointmentId?: string;
  providerId?: string;
  appointmentType?: string;
  preferredDate?: string;
  preferredTime?: string;
  duration?: number;
  notes?: string;
  sendCalendarInvite?: boolean;
}

interface TimeSlot {
  startTime: string;
  endTime: string;
  providerId: string;
  providerName: string;
  available: boolean;
}

/**
 * Appointment Scheduler Lambda
 *
 * Handles all appointment scheduling operations:
 * - Check available time slots from Google Calendar
 * - Book appointments and sync to Google Calendar
 * - Send calendar invites to patient's Gmail
 * - Handle rescheduling and cancellations
 * - Store all appointment data in DynamoDB
 */
export const handler = async (event: AppointmentRequest | any): Promise<any> => {
  console.log('Appointment Scheduler Event:', JSON.stringify(event, null, 2));

  try {
    // Handle API Gateway events
    if (event.httpMethod) {
      return handleApiRequest(event);
    }

    // Handle direct invocations
    const request: AppointmentRequest = event;

    switch (request.action) {
      case 'getAvailableSlots':
        return getAvailableSlots(request);

      case 'bookAppointment':
        return bookAppointment(request);

      case 'reschedule':
        return rescheduleAppointment(request);

      case 'cancel':
        return cancelAppointment(request);

      case 'getAppointment':
        return getAppointment(request.appointmentId!);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in appointment scheduler:', error);
    return {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Handle API Gateway requests
 */
async function handleApiRequest(event: any): Promise<any> {
  const { httpMethod, body, pathParameters } = event;
  const appointmentId = pathParameters?.appointmentId;
  const data = body ? JSON.parse(body) : {};

  switch (httpMethod) {
    case 'GET':
      if (appointmentId) {
        return formatResponse(200, await getAppointment(appointmentId));
      }
      return formatResponse(200, await getAvailableSlots(data));

    case 'POST':
      return formatResponse(201, await bookAppointment(data));

    case 'PUT':
      return formatResponse(200, await rescheduleAppointment({ ...data, appointmentId }));

    case 'DELETE':
      return formatResponse(200, await cancelAppointment({ appointmentId }));

    default:
      return formatResponse(405, { error: 'Method not allowed' });
  }
}

/**
 * Get available time slots
 */
async function getAvailableSlots(request: AppointmentRequest): Promise<{ slots: TimeSlot[] }> {
  const { providerId, preferredDate, appointmentType, duration = 30 } = request;

  // Get Google Calendar client
  const calendar = await getGoogleCalendar();
  const calendarId = await getCalendarId();

  // Calculate date range
  const startDate = preferredDate ? new Date(preferredDate) : new Date();
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 7); // Look 7 days ahead

  // Get busy times from Google Calendar
  const busyResponse = await calendar.freebusy.query({
    requestBody: {
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      items: [{ id: calendarId }],
    },
  });

  const busyTimes = busyResponse.data.calendars?.[calendarId]?.busy || [];

  // Generate available slots
  const slots = generateAvailableSlots(startDate, endDate, busyTimes, duration, providerId);

  return { slots };
}

/**
 * Generate available time slots
 */
function generateAvailableSlots(
  startDate: Date,
  endDate: Date,
  busyTimes: calendar_v3.Schema$TimePeriod[],
  duration: number,
  providerId?: string
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const workingHours = { start: 9, end: 17 }; // 9 AM to 5 PM

  // Iterate through each day
  const current = new Date(startDate);
  while (current < endDate) {
    // Skip weekends
    if (current.getDay() !== 0 && current.getDay() !== 6) {
      // Generate slots for each working hour
      for (let hour = workingHours.start; hour < workingHours.end; hour++) {
        for (let minute = 0; minute < 60; minute += duration) {
          const slotStart = new Date(current);
          slotStart.setHours(hour, minute, 0, 0);

          const slotEnd = new Date(slotStart);
          slotEnd.setMinutes(slotEnd.getMinutes() + duration);

          // Check if slot conflicts with busy times
          const isAvailable = !busyTimes.some(busy => {
            const busyStart = new Date(busy.start!);
            const busyEnd = new Date(busy.end!);
            return slotStart < busyEnd && slotEnd > busyStart;
          });

          if (isAvailable && slotStart > new Date()) {
            slots.push({
              startTime: slotStart.toISOString(),
              endTime: slotEnd.toISOString(),
              providerId: providerId || 'default',
              providerName: 'Dr. CloudWest',
              available: true,
            });
          }
        }
      }
    }
    current.setDate(current.getDate() + 1);
  }

  // Return first 20 available slots
  return slots.slice(0, 20);
}

/**
 * Book an appointment
 */
async function bookAppointment(request: AppointmentRequest): Promise<any> {
  const {
    patientId,
    providerId,
    appointmentType,
    preferredDate,
    preferredTime,
    duration = 30,
    notes,
    sendCalendarInvite = true,
  } = request;

  if (!patientId || !preferredDate || !preferredTime) {
    return { error: 'Missing required fields' };
  }

  // Get patient info
  const patient = await getPatient(patientId);
  if (!patient) {
    return { error: 'Patient not found' };
  }

  const appointmentId = randomUUID();
  const appointmentDateTime = new Date(`${preferredDate}T${preferredTime}`);
  const appointmentEndTime = new Date(appointmentDateTime);
  appointmentEndTime.setMinutes(appointmentEndTime.getMinutes() + duration);

  // Create Google Calendar event
  let googleEventId: string | undefined;
  if (sendCalendarInvite && patient.email) {
    googleEventId = await createCalendarEvent({
      summary: `Medical Appointment - ${appointmentType || 'General'}`,
      description: `Appointment for ${patient.firstName} ${patient.lastName}\n\nNotes: ${notes || 'None'}`,
      startTime: appointmentDateTime.toISOString(),
      endTime: appointmentEndTime.toISOString(),
      attendeeEmail: patient.email,
    });
  }

  // Store appointment in DynamoDB
  const now = new Date().toISOString();
  const appointment = {
    appointmentId,
    patientId,
    providerId: providerId || 'default',
    appointmentType: appointmentType || 'general',
    appointmentDateTime: appointmentDateTime.toISOString(),
    appointmentDate: preferredDate,
    appointmentTime: preferredTime,
    duration,
    endTime: appointmentEndTime.toISOString(),
    status: 'scheduled',
    notes,
    googleCalendarEventId: googleEventId,
    patientEmail: patient.email,
    patientPhone: patient.phoneNumber,
    patientName: `${patient.firstName} ${patient.lastName}`,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: APPOINTMENT_TABLE,
    Item: appointment,
  }));

  // Emit event
  await emitEvent('AppointmentBooked', {
    appointmentId,
    patientId,
    appointmentDateTime: appointmentDateTime.toISOString(),
    appointmentType,
    googleEventId,
    timestamp: now,
  });

  return {
    success: true,
    appointment,
    calendarInviteSent: !!googleEventId,
  };
}

/**
 * Reschedule an appointment
 */
async function rescheduleAppointment(request: AppointmentRequest): Promise<any> {
  const { appointmentId, preferredDate, preferredTime, duration = 30 } = request;

  if (!appointmentId || !preferredDate || !preferredTime) {
    return { error: 'Missing required fields' };
  }

  // Get existing appointment
  const existing = await getAppointment(appointmentId);
  if (!existing || existing.error) {
    return { error: 'Appointment not found' };
  }

  const newDateTime = new Date(`${preferredDate}T${preferredTime}`);
  const newEndTime = new Date(newDateTime);
  newEndTime.setMinutes(newEndTime.getMinutes() + duration);
  const now = new Date().toISOString();

  // Update Google Calendar event if exists
  if (existing.googleCalendarEventId) {
    await updateCalendarEvent(existing.googleCalendarEventId, {
      startTime: newDateTime.toISOString(),
      endTime: newEndTime.toISOString(),
    });
  }

  // Update DynamoDB
  await docClient.send(new UpdateCommand({
    TableName: APPOINTMENT_TABLE,
    Key: { appointmentId },
    UpdateExpression: 'SET appointmentDateTime = :dt, appointmentDate = :date, appointmentTime = :time, endTime = :endTime, #status = :status, updatedAt = :now',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':dt': newDateTime.toISOString(),
      ':date': preferredDate,
      ':time': preferredTime,
      ':endTime': newEndTime.toISOString(),
      ':status': 'rescheduled',
      ':now': now,
    },
  }));

  // Emit event
  await emitEvent('AppointmentRescheduled', {
    appointmentId,
    patientId: existing.patientId,
    oldDateTime: existing.appointmentDateTime,
    newDateTime: newDateTime.toISOString(),
    timestamp: now,
  });

  return {
    success: true,
    appointmentId,
    newDateTime: newDateTime.toISOString(),
  };
}

/**
 * Cancel an appointment
 */
async function cancelAppointment(request: { appointmentId?: string }): Promise<any> {
  const { appointmentId } = request;

  if (!appointmentId) {
    return { error: 'Appointment ID required' };
  }

  // Get existing appointment
  const existing = await getAppointment(appointmentId);
  if (!existing || existing.error) {
    return { error: 'Appointment not found' };
  }

  const now = new Date().toISOString();

  // Delete Google Calendar event if exists
  if (existing.googleCalendarEventId) {
    await deleteCalendarEvent(existing.googleCalendarEventId);
  }

  // Update status in DynamoDB
  await docClient.send(new UpdateCommand({
    TableName: APPOINTMENT_TABLE,
    Key: { appointmentId },
    UpdateExpression: 'SET #status = :status, cancelledAt = :now, updatedAt = :now',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':status': 'cancelled',
      ':now': now,
    },
  }));

  // Emit event
  await emitEvent('AppointmentCancelled', {
    appointmentId,
    patientId: existing.patientId,
    timestamp: now,
  });

  return {
    success: true,
    appointmentId,
    status: 'cancelled',
  };
}

/**
 * Get appointment by ID
 */
async function getAppointment(appointmentId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: APPOINTMENT_TABLE,
    Key: { appointmentId },
  }));

  if (!result.Item) {
    return { error: 'Appointment not found' };
  }

  return result.Item;
}

/**
 * Get patient by ID
 */
async function getPatient(patientId: string): Promise<any> {
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
 * Get Google Calendar client
 */
async function getGoogleCalendar(): Promise<calendar_v3.Calendar> {
  const secret = await getSecret(GOOGLE_SECRET_NAME);

  const auth = new google.auth.OAuth2(
    secret.clientId,
    secret.clientSecret
  );

  auth.setCredentials({
    refresh_token: secret.refreshToken,
  });

  return google.calendar({ version: 'v3', auth });
}

/**
 * Get calendar ID from secrets
 */
async function getCalendarId(): Promise<string> {
  const secret = await getSecret(GOOGLE_SECRET_NAME);
  return secret.calendarId;
}

/**
 * Create Google Calendar event
 */
async function createCalendarEvent(data: {
  summary: string;
  description: string;
  startTime: string;
  endTime: string;
  attendeeEmail: string;
}): Promise<string | undefined> {
  try {
    const calendar = await getGoogleCalendar();
    const calendarId = await getCalendarId();

    const response = await calendar.events.insert({
      calendarId,
      sendUpdates: 'all', // Send email invitations
      requestBody: {
        summary: data.summary,
        description: data.description,
        start: {
          dateTime: data.startTime,
          timeZone: 'America/Los_Angeles',
        },
        end: {
          dateTime: data.endTime,
          timeZone: 'America/Los_Angeles',
        },
        attendees: [
          { email: data.attendeeEmail },
        ],
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 }, // 1 day before
            { method: 'email', minutes: 60 }, // 1 hour before
          ],
        },
      },
    });

    return response.data.id || undefined;
  } catch (error) {
    console.error('Error creating calendar event:', error);
    return undefined;
  }
}

/**
 * Update Google Calendar event
 */
async function updateCalendarEvent(
  eventId: string,
  data: { startTime: string; endTime: string }
): Promise<void> {
  try {
    const calendar = await getGoogleCalendar();
    const calendarId = await getCalendarId();

    await calendar.events.patch({
      calendarId,
      eventId,
      sendUpdates: 'all',
      requestBody: {
        start: {
          dateTime: data.startTime,
          timeZone: 'America/Los_Angeles',
        },
        end: {
          dateTime: data.endTime,
          timeZone: 'America/Los_Angeles',
        },
      },
    });
  } catch (error) {
    console.error('Error updating calendar event:', error);
  }
}

/**
 * Delete Google Calendar event
 */
async function deleteCalendarEvent(eventId: string): Promise<void> {
  try {
    const calendar = await getGoogleCalendar();
    const calendarId = await getCalendarId();

    await calendar.events.delete({
      calendarId,
      eventId,
      sendUpdates: 'all',
    });
  } catch (error) {
    console.error('Error deleting calendar event:', error);
  }
}

/**
 * Get secret from Secrets Manager
 */
async function getSecret(secretName: string): Promise<any> {
  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await secretsManager.send(command);
  return JSON.parse(response.SecretString || '{}');
}

/**
 * Emit event to EventBridge
 */
async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [
      {
        EventBusName: EVENT_BUS_NAME,
        Source: 'medcx.appointments',
        DetailType: detailType,
        Detail: JSON.stringify(detail),
      },
    ],
  }));
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
    },
    body: JSON.stringify(body),
  };
}
