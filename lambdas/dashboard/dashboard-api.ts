import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;
const PAYMENT_TABLE = process.env.PAYMENT_TABLE!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;

/**
 * Dashboard API Lambda
 *
 * Powers the Patient 360 dashboard for agents:
 * - Patient search and lookup
 * - Real-time patient view
 * - Quick actions
 * - Agent metrics
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Dashboard API Event:', JSON.stringify(event, null, 2));

  try {
    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method;
    const pathParams = event.pathParameters || {};
    const queryParams = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

    // Route based on path
    if (path.includes('/patients/search')) {
      return handlePatientSearch(queryParams);
    }

    if (path.includes('/patients/') && pathParams.patientId) {
      if (path.includes('/360')) {
        return handlePatient360(pathParams.patientId);
      }
      if (path.includes('/conversations')) {
        return handlePatientConversations(pathParams.patientId, queryParams);
      }
      if (path.includes('/appointments')) {
        return handlePatientAppointments(pathParams.patientId, queryParams);
      }
      if (path.includes('/payments')) {
        return handlePatientPayments(pathParams.patientId);
      }
      if (path.includes('/send-message') && method === 'POST') {
        return handleSendMessage(pathParams.patientId, body);
      }
      return handleGetPatient(pathParams.patientId);
    }

    if (path.includes('/metrics')) {
      return handleGetMetrics(queryParams);
    }

    if (path.includes('/queue')) {
      return handleGetQueueStatus();
    }

    if (path.includes('/recent-interactions')) {
      return handleRecentInteractions(queryParams);
    }

    return formatResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Error in dashboard API:', error);
    return formatResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Search patients
 */
async function handlePatientSearch(params: any): Promise<any> {
  const { q, phone, email, name, limit = '20' } = params;

  if (phone) {
    const result = await docClient.send(new QueryCommand({
      TableName: PATIENT_TABLE,
      IndexName: 'phone-index',
      KeyConditionExpression: 'phoneNumber = :phone',
      ExpressionAttributeValues: { ':phone': normalizePhone(phone) },
    }));

    return formatResponse(200, { patients: result.Items || [] });
  }

  if (email) {
    const result = await docClient.send(new QueryCommand({
      TableName: PATIENT_TABLE,
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: { ':email': email.toLowerCase() },
    }));

    return formatResponse(200, { patients: result.Items || [] });
  }

  if (name || q) {
    const searchTerm = (name || q).toLowerCase();
    // In production, would use OpenSearch for better full-text search
    const result = await docClient.send(new ScanCommand({
      TableName: PATIENT_TABLE,
      FilterExpression: 'contains(#firstName, :search) OR contains(#lastName, :search)',
      ExpressionAttributeNames: {
        '#firstName': 'firstName',
        '#lastName': 'lastName',
      },
      ExpressionAttributeValues: { ':search': searchTerm },
      Limit: parseInt(limit),
    }));

    return formatResponse(200, { patients: result.Items || [] });
  }

  return formatResponse(400, { error: 'Search query required (q, phone, email, or name)' });
}

/**
 * Get patient 360 view
 */
async function handlePatient360(patientId: string): Promise<any> {
  const [patient, appointments, conversations, payments, interactions] = await Promise.all([
    getPatient(patientId),
    getPatientAppointments(patientId),
    getPatientConversations(patientId),
    getPatientPayments(patientId),
    getPatientInteractions(patientId),
  ]);

  if (!patient) {
    return formatResponse(404, { error: 'Patient not found' });
  }

  const now = new Date();
  const upcomingAppointments = appointments.filter(
    (a: any) => new Date(a.appointmentDate) >= now && a.status !== 'cancelled'
  );
  const pastAppointments = appointments.filter(
    (a: any) => new Date(a.appointmentDate) < now
  );

  const pendingPayments = payments.filter((p: any) => p.status === 'pending');

  // Get channel history
  const channelHistory = [...new Set(interactions.map((i: any) => i.channel).filter(Boolean))];

  return formatResponse(200, {
    patient: {
      patientId: patient.patientId,
      name: `${patient.firstName || ''} ${patient.lastName || ''}`.trim(),
      firstName: patient.firstName,
      lastName: patient.lastName,
      dateOfBirth: patient.dateOfBirth,
      phoneNumber: patient.phoneNumber,
      email: patient.email,
      address: patient.address,
      preferredChannel: patient.preferredChannel || 'sms',
      preferredLanguage: patient.preferredLanguage || 'en',
      insurance: patient.insurance,
      insuranceVerified: patient.insurance?.verified || false,
      idVerified: patient.idVerification?.verified || false,
    },
    appointments: {
      upcoming: upcomingAppointments.slice(0, 5),
      past: pastAppointments.slice(0, 5),
      nextAppointment: upcomingAppointments[0],
      totalUpcoming: upcomingAppointments.length,
      totalPast: pastAppointments.length,
    },
    conversations: {
      recent: conversations.slice(0, 10),
      totalMessages: conversations.length,
      lastMessage: conversations[0],
    },
    payments: {
      pending: pendingPayments,
      pendingTotal: pendingPayments.reduce((sum: number, p: any) => sum + p.amount, 0),
      recent: payments.slice(0, 5),
    },
    activity: {
      channelHistory,
      lastInteraction: interactions[0]?.interactionTimestamp,
      recentInteractions: interactions.slice(0, 10),
    },
    quickFacts: buildQuickFacts(patient, upcomingAppointments, pendingPayments),
  });
}

/**
 * Get patient details
 */
async function handleGetPatient(patientId: string): Promise<any> {
  const patient = await getPatient(patientId);

  if (!patient) {
    return formatResponse(404, { error: 'Patient not found' });
  }

  return formatResponse(200, { patient });
}

/**
 * Get patient conversations
 */
async function handlePatientConversations(patientId: string, params: any): Promise<any> {
  const { channel, limit = '50' } = params;

  const result = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    KeyConditionExpression: 'patientId = :patientId',
    FilterExpression: channel ? 'channel = :channel' : undefined,
    ExpressionAttributeValues: {
      ':patientId': patientId,
      ...(channel && { ':channel': channel }),
    },
    ScanIndexForward: false,
    Limit: parseInt(limit),
  }));

  return formatResponse(200, {
    patientId,
    conversations: result.Items || [],
    count: result.Items?.length || 0,
  });
}

/**
 * Get patient appointments
 */
async function handlePatientAppointments(patientId: string, params: any): Promise<any> {
  const { status, startDate, endDate, limit = '20' } = params;

  let filterExpression: string | undefined;
  const expressionValues: any = { ':patientId': patientId };

  if (status) {
    filterExpression = '#status = :status';
    expressionValues[':status'] = status;
  }

  const result = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    FilterExpression: filterExpression,
    ExpressionAttributeNames: status ? { '#status': 'status' } : undefined,
    ExpressionAttributeValues: expressionValues,
    Limit: parseInt(limit),
  }));

  return formatResponse(200, {
    patientId,
    appointments: result.Items || [],
    count: result.Items?.length || 0,
  });
}

/**
 * Get patient payments
 */
async function handlePatientPayments(patientId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: PAYMENT_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
  }));

  const payments = result.Items || [];
  const pending = payments.filter((p: any) => p.status === 'pending');
  const completed = payments.filter((p: any) => p.status === 'completed');

  return formatResponse(200, {
    patientId,
    payments,
    summary: {
      pendingCount: pending.length,
      pendingTotal: pending.reduce((sum: number, p: any) => sum + p.amount, 0),
      completedCount: completed.length,
      completedTotal: completed.reduce((sum: number, p: any) => sum + p.amount, 0),
    },
  });
}

/**
 * Send message to patient
 */
async function handleSendMessage(patientId: string, body: any): Promise<any> {
  const { message, channel = 'sms' } = body;

  if (!message) {
    return formatResponse(400, { error: 'Message is required' });
  }

  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendOutbound',
    channel,
    patientId,
    content: message,
  });

  return formatResponse(200, {
    success: true,
    patientId,
    channel,
    message: 'Message sent',
  });
}

/**
 * Get metrics
 */
async function handleGetMetrics(params: any): Promise<any> {
  const { period = 'today' } = params;
  const now = new Date();

  let startDate: string;
  if (period === 'today') {
    startDate = new Date(now.setHours(0, 0, 0, 0)).toISOString();
  } else if (period === 'week') {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    startDate = weekAgo.toISOString();
  } else {
    startDate = new Date(now.setHours(0, 0, 0, 0)).toISOString();
  }

  // Get appointments for period
  const appointmentsResult = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'date-index',
    KeyConditionExpression: 'appointmentDate >= :startDate',
    ExpressionAttributeValues: { ':startDate': startDate.split('T')[0] },
  }));

  const appointments = appointmentsResult.Items || [];

  return formatResponse(200, {
    period,
    metrics: {
      appointments: {
        total: appointments.length,
        scheduled: appointments.filter((a: any) => a.status === 'scheduled').length,
        completed: appointments.filter((a: any) => a.status === 'completed').length,
        cancelled: appointments.filter((a: any) => a.status === 'cancelled').length,
        noShow: appointments.filter((a: any) => a.status === 'no_show').length,
      },
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Get queue status
 */
async function handleGetQueueStatus(): Promise<any> {
  // In production, would integrate with Amazon Connect
  return formatResponse(200, {
    queue: {
      waitingContacts: 0,
      averageWaitTime: 0,
      longestWaitTime: 0,
      activeAgents: 1,
      availableAgents: 1,
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Get recent interactions
 */
async function handleRecentInteractions(params: any): Promise<any> {
  const { limit = '20' } = params;

  // In production, would use a GSI with timestamp for efficient querying
  const result = await docClient.send(new ScanCommand({
    TableName: INTERACTION_TABLE,
    Limit: parseInt(limit),
  }));

  // Sort by timestamp
  const sorted = (result.Items || []).sort((a: any, b: any) =>
    new Date(b.interactionTimestamp).getTime() - new Date(a.interactionTimestamp).getTime()
  );

  return formatResponse(200, {
    interactions: sorted,
    count: sorted.length,
  });
}

// Helper functions
async function getPatient(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));
  return result.Item;
}

async function getPatientAppointments(patientId: string): Promise<any[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
  }));
  return (result.Items || []).sort((a: any, b: any) =>
    new Date(a.appointmentDate).getTime() - new Date(b.appointmentDate).getTime()
  );
}

async function getPatientConversations(patientId: string): Promise<any[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
    Limit: 50,
  }));
  return result.Items || [];
}

async function getPatientPayments(patientId: string): Promise<any[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: PAYMENT_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
  }));
  return result.Items || [];
}

async function getPatientInteractions(patientId: string): Promise<any[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: INTERACTION_TABLE,
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
    Limit: 50,
  }));
  return result.Items || [];
}

function buildQuickFacts(patient: any, appointments: any[], payments: any[]): string[] {
  const facts: string[] = [];

  if (appointments.length > 0) {
    const next = appointments[0];
    facts.push(`Next: ${next.appointmentDate} at ${next.appointmentTime}`);
  } else {
    facts.push('No upcoming appointments');
  }

  if (payments.length > 0) {
    const total = payments.reduce((sum, p) => sum + p.amount, 0);
    facts.push(`Pending: $${total.toFixed(2)}`);
  }

  if (patient.insurance?.verified) {
    facts.push(`Insurance: ${patient.insurance.insurerName || 'Verified'}`);
  }

  if (patient.preferredChannel) {
    facts.push(`Prefers: ${patient.preferredChannel}`);
  }

  return facts;
}

function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  if (!digits.startsWith('+')) digits = '+' + digits;
  return digits;
}

async function invokeFunction(functionArn: string, payload: any): Promise<any> {
  const command = new InvokeCommand({
    FunctionName: functionArn,
    Payload: JSON.stringify(payload),
  });
  const response = await lambdaClient.send(command);
  return JSON.parse(new TextDecoder().decode(response.Payload));
}

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
