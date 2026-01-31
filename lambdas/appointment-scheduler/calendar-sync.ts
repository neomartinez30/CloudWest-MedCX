import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

const secretsManager = new SecretsManagerClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const GOOGLE_CREDENTIALS_SECRET = process.env.GOOGLE_CREDENTIALS_SECRET!;
const OAUTH_TOKENS_TABLE = process.env.OAUTH_TOKENS_TABLE!;
const GOOGLE_API_BASE = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

interface CalendarEventRequest {
  calendarId: string;
  summary: string;
  description?: string;
  startDateTime: string;
  endDateTime: string;
  attendeeEmail?: string;
  credentials?: any;
}

interface CalendarEventUpdateRequest {
  calendarId: string;
  eventId: string;
  startDateTime?: string;
  endDateTime?: string;
  summary?: string;
  description?: string;
  credentials?: any;
}

interface CalendarEventDeleteRequest {
  calendarId: string;
  eventId: string;
  credentials?: any;
}

interface AvailableSlotsRequest {
  calendarId: string;
  date: string;
  duration: number;
  timeRange?: { start: string; end: string };
  credentials?: any;
}

interface CalendarInviteRequest {
  calendarId: string;
  eventId: string;
  recipientEmail: string;
  credentials?: any;
}

interface TimeSlot {
  date: string;
  time: string;
  endTime: string;
}

/**
 * Google Calendar Sync Module
 *
 * Handles all Google Calendar integrations including:
 * - OAuth token management and refresh
 * - Creating/updating/deleting calendar events
 * - Fetching available time slots
 * - Sending calendar invites
 */

/**
 * Get Google API credentials from Secrets Manager
 */
async function getGoogleCredentials(): Promise<GoogleCredentials> {
  const command = new GetSecretValueCommand({
    SecretId: GOOGLE_CREDENTIALS_SECRET,
  });

  const response = await secretsManager.send(command);
  if (!response.SecretString) {
    throw new Error('Google credentials not found in Secrets Manager');
  }

  return JSON.parse(response.SecretString);
}

/**
 * Get OAuth tokens for a specific calendar/user
 */
async function getOAuthTokens(calendarId: string): Promise<OAuthTokens | null> {
  const result = await docClient.send(new GetCommand({
    TableName: OAUTH_TOKENS_TABLE,
    Key: { calendarId },
  }));

  if (!result.Item) {
    return null;
  }

  return {
    accessToken: result.Item.accessToken,
    refreshToken: result.Item.refreshToken,
    expiresAt: result.Item.expiresAt,
    scope: result.Item.scope,
  };
}

/**
 * Save OAuth tokens
 */
async function saveOAuthTokens(calendarId: string, tokens: OAuthTokens): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: OAUTH_TOKENS_TABLE,
    Item: {
      calendarId,
      ...tokens,
      updatedAt: new Date().toISOString(),
    },
  }));
}

/**
 * Refresh expired OAuth access token
 */
async function refreshAccessToken(calendarId: string, refreshToken: string): Promise<string> {
  const credentials = await getGoogleCredentials();

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Token refresh failed:', error);
    throw new Error('Failed to refresh OAuth token');
  }

  const data = await response.json();

  // Save updated tokens
  const expiresAt = Date.now() + (data.expires_in * 1000);
  await saveOAuthTokens(calendarId, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
    scope: data.scope,
  });

  return data.access_token;
}

/**
 * Get valid access token (refreshing if needed)
 */
async function getValidAccessToken(calendarId: string): Promise<string> {
  const tokens = await getOAuthTokens(calendarId);

  if (!tokens) {
    throw new Error(`No OAuth tokens found for calendar: ${calendarId}. Authorization required.`);
  }

  // Check if token is expired or about to expire (5 minute buffer)
  const bufferMs = 5 * 60 * 1000;
  if (Date.now() + bufferMs >= tokens.expiresAt) {
    console.log('Access token expired, refreshing...');
    return await refreshAccessToken(calendarId, tokens.refreshToken);
  }

  return tokens.accessToken;
}

/**
 * Make authenticated Google Calendar API request
 */
async function googleCalendarRequest(
  calendarId: string,
  endpoint: string,
  method: string = 'GET',
  body?: any
): Promise<any> {
  const accessToken = await getValidAccessToken(calendarId);

  const response = await fetch(`${GOOGLE_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Google Calendar API error: ${response.status}`, error);
    throw new Error(`Google Calendar API error: ${response.status} - ${error}`);
  }

  // DELETE requests may not have a body
  if (method === 'DELETE') {
    return { success: true };
  }

  return response.json();
}

/**
 * Get available time slots for a specific date
 */
export async function getAvailableSlots(request: AvailableSlotsRequest): Promise<TimeSlot[]> {
  const { calendarId, date, duration, timeRange } = request;

  // Default business hours
  const startHour = timeRange?.start || '08:00';
  const endHour = timeRange?.end || '17:00';

  // Get busy times from Google Calendar
  const timeMin = `${date}T${startHour}:00-07:00`;
  const timeMax = `${date}T${endHour}:00-07:00`;

  try {
    const freeBusyResponse = await googleCalendarRequest(
      calendarId,
      '/freeBusy',
      'POST',
      {
        timeMin,
        timeMax,
        items: [{ id: calendarId }],
      }
    );

    const busySlots = freeBusyResponse.calendars?.[calendarId]?.busy || [];

    // Generate all possible slots
    const allSlots = generateTimeSlots(date, startHour, endHour, duration);

    // Filter out busy slots
    const availableSlots = allSlots.filter(slot => {
      const slotStart = new Date(`${date}T${slot.time}:00`);
      const slotEnd = new Date(`${date}T${slot.endTime}:00`);

      return !busySlots.some((busy: { start: string; end: string }) => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return slotStart < busyEnd && slotEnd > busyStart;
      });
    });

    return availableSlots;
  } catch (error) {
    console.error('Error fetching available slots:', error);

    // Fallback: return all possible slots if calendar check fails
    console.log('Returning all possible slots as fallback');
    return generateTimeSlots(date, startHour, endHour, duration);
  }
}

/**
 * Generate time slots for a given date and duration
 */
function generateTimeSlots(
  date: string,
  startHour: string,
  endHour: string,
  durationMinutes: number
): TimeSlot[] {
  const slots: TimeSlot[] = [];

  const [startH, startM] = startHour.split(':').map(Number);
  const [endH, endM] = endHour.split(':').map(Number);

  let currentMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  while (currentMinutes + durationMinutes <= endMinutes) {
    const hours = Math.floor(currentMinutes / 60);
    const minutes = currentMinutes % 60;
    const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

    const endSlotMinutes = currentMinutes + durationMinutes;
    const endSlotHours = Math.floor(endSlotMinutes / 60);
    const endSlotMins = endSlotMinutes % 60;
    const endTime = `${endSlotHours.toString().padStart(2, '0')}:${endSlotMins.toString().padStart(2, '0')}`;

    slots.push({ date, time, endTime });

    // Move to next slot (30 minute intervals)
    currentMinutes += 30;
  }

  return slots;
}

/**
 * Create a new calendar event
 */
export async function createCalendarEvent(request: CalendarEventRequest): Promise<string> {
  const { calendarId, summary, description, startDateTime, endDateTime, attendeeEmail } = request;

  const event: any = {
    summary,
    description,
    start: {
      dateTime: startDateTime,
      timeZone: 'America/Los_Angeles',
    },
    end: {
      dateTime: endDateTime,
      timeZone: 'America/Los_Angeles',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 }, // 24 hours before
        { method: 'popup', minutes: 60 },      // 1 hour before
        { method: 'popup', minutes: 15 },      // 15 minutes before
      ],
    },
  };

  // Add attendee if email provided
  if (attendeeEmail) {
    event.attendees = [
      { email: attendeeEmail, responseStatus: 'needsAction' },
    ];
    event.guestsCanModify = false;
    event.guestsCanSeeOtherGuests = false;
  }

  const response = await googleCalendarRequest(
    calendarId,
    `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all`,
    'POST',
    event
  );

  console.log('Calendar event created:', response.id);
  return response.id;
}

/**
 * Update an existing calendar event
 */
export async function updateCalendarEvent(request: CalendarEventUpdateRequest): Promise<void> {
  const { calendarId, eventId, startDateTime, endDateTime, summary, description } = request;

  // First, get the existing event
  const existingEvent = await googleCalendarRequest(
    calendarId,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  );

  // Update only provided fields
  const updatedEvent: any = { ...existingEvent };

  if (startDateTime) {
    updatedEvent.start = {
      dateTime: startDateTime,
      timeZone: 'America/Los_Angeles',
    };
  }

  if (endDateTime) {
    updatedEvent.end = {
      dateTime: endDateTime,
      timeZone: 'America/Los_Angeles',
    };
  }

  if (summary) {
    updatedEvent.summary = summary;
  }

  if (description) {
    updatedEvent.description = description;
  }

  await googleCalendarRequest(
    calendarId,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    'PUT',
    updatedEvent
  );

  console.log('Calendar event updated:', eventId);
}

/**
 * Delete a calendar event
 */
export async function deleteCalendarEvent(request: CalendarEventDeleteRequest): Promise<void> {
  const { calendarId, eventId } = request;

  await googleCalendarRequest(
    calendarId,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    'DELETE'
  );

  console.log('Calendar event deleted:', eventId);
}

/**
 * Send calendar invite to patient's email
 */
export async function sendCalendarInvite(request: CalendarInviteRequest): Promise<void> {
  const { calendarId, eventId, recipientEmail } = request;

  // Get the event
  const event = await googleCalendarRequest(
    calendarId,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  );

  // Check if attendee already exists
  const existingAttendees = event.attendees || [];
  const alreadyInvited = existingAttendees.some(
    (attendee: any) => attendee.email.toLowerCase() === recipientEmail.toLowerCase()
  );

  if (alreadyInvited) {
    console.log('Attendee already invited:', recipientEmail);
    return;
  }

  // Add the new attendee
  const updatedAttendees = [
    ...existingAttendees,
    { email: recipientEmail, responseStatus: 'needsAction' },
  ];

  await googleCalendarRequest(
    calendarId,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    'PATCH',
    { attendees: updatedAttendees }
  );

  console.log('Calendar invite sent to:', recipientEmail);
}

/**
 * Initiate OAuth flow for a new calendar connection
 */
export async function initiateOAuthFlow(calendarId: string, redirectUri?: string): Promise<string> {
  const credentials = await getGoogleCredentials();

  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ];

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', credentials.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri || credentials.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', calendarId);

  return authUrl.toString();
}

/**
 * Handle OAuth callback and store tokens
 */
export async function handleOAuthCallback(
  code: string,
  calendarId: string,
  redirectUri?: string
): Promise<void> {
  const credentials = await getGoogleCredentials();

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: redirectUri || credentials.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('OAuth token exchange failed:', error);
    throw new Error('Failed to exchange OAuth code for tokens');
  }

  const data = await response.json();

  // Save tokens
  await saveOAuthTokens(calendarId, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    scope: data.scope,
  });

  console.log('OAuth tokens saved for calendar:', calendarId);
}

/**
 * Revoke OAuth tokens for a calendar
 */
export async function revokeOAuthTokens(calendarId: string): Promise<void> {
  const tokens = await getOAuthTokens(calendarId);

  if (!tokens) {
    console.log('No tokens to revoke for calendar:', calendarId);
    return;
  }

  // Revoke token at Google
  await fetch(`https://oauth2.googleapis.com/revoke?token=${tokens.accessToken}`, {
    method: 'POST',
  });

  // Delete from DynamoDB
  await docClient.send(new PutCommand({
    TableName: OAUTH_TOKENS_TABLE,
    Item: {
      calendarId,
      revoked: true,
      revokedAt: new Date().toISOString(),
    },
  }));

  console.log('OAuth tokens revoked for calendar:', calendarId);
}

/**
 * Check if calendar is connected and tokens are valid
 */
export async function isCalendarConnected(calendarId: string): Promise<boolean> {
  try {
    const tokens = await getOAuthTokens(calendarId);
    if (!tokens) return false;

    // Try to get valid access token (will refresh if needed)
    await getValidAccessToken(calendarId);
    return true;
  } catch (error) {
    console.error('Calendar connection check failed:', error);
    return false;
  }
}
