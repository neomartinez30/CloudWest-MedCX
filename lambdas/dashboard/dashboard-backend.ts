import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;

/**
 * Dashboard Backend Lambda
 *
 * Provides API endpoints for the Patient 360 dashboard:
 * - Agent metrics and queue status
 * - Patient search
 * - Quick actions (send message, create task)
 * - Real-time updates
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Dashboard Backend Event:', JSON.stringify(event, null, 2));

  try {
    const path = event.path || event.rawPath;
    const method = event.httpMethod || event.requestContext?.http?.method;

    // Route based on path
    if (path.includes('/dashboard')) {
      if (path.includes('/queue')) {
        return getQueueStatus();
      }
      return getDashboardMetrics();
    }

    if (path.includes('/search/patients')) {
      return searchPatients(event.queryStringParameters);
    }

    if (path.includes('/actions/send-message')) {
      return sendMessage(JSON.parse(event.body || '{}'));
    }

    if (path.includes('/actions/create-task')) {
      return createTask(JSON.parse(event.body || '{}'));
    }

    return formatResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Error in dashboard backend:', error);
    return formatResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Get dashboard metrics for agent
 */
async function getDashboardMetrics(): Promise<any> {
  const now = new Date();
  const todayStart = new Date(now.setHours(0, 0, 0, 0)).toISOString();

  // Get today's appointments
  const appointmentsResult = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'date-index',
    KeyConditionExpression: 'appointmentDate = :today',
    ExpressionAttributeValues: {
      ':today': todayStart.split('T')[0],
    },
  }));

  const appointments = appointmentsResult.Items || [];

  return formatResponse(200, {
    metrics: {
      todayAppointments: appointments.length,
      completedAppointments: appointments.filter((a: any) => a.status === 'completed').length,
      pendingAppointments: appointments.filter((a: any) => a.status === 'scheduled').length,
      cancelledAppointments: appointments.filter((a: any) => a.status === 'cancelled').length,
    },
    recentAppointments: appointments.slice(0, 10),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Get queue status
 */
async function getQueueStatus(): Promise<any> {
  // In production, this would integrate with Amazon Connect
  return formatResponse(200, {
    queue: {
      waitingContacts: 0,
      averageWaitTime: 0,
      activeAgents: 1,
      availableAgents: 1,
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Search patients
 */
async function searchPatients(queryParams: any): Promise<any> {
  const { query, phone, email } = queryParams || {};

  if (phone) {
    const result = await docClient.send(new QueryCommand({
      TableName: PATIENT_TABLE,
      IndexName: 'phone-index',
      KeyConditionExpression: 'phoneNumber = :phone',
      ExpressionAttributeValues: { ':phone': phone },
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

  return formatResponse(400, { error: 'Search query required (phone or email)' });
}

/**
 * Send message to patient
 */
async function sendMessage(data: { patientId: string; message: string; channel?: string }): Promise<any> {
  // This would invoke the channel router
  return formatResponse(200, {
    success: true,
    message: 'Message sent',
    patientId: data.patientId,
  });
}

/**
 * Create task for patient
 */
async function createTask(data: { patientId: string; taskType: string; description: string }): Promise<any> {
  return formatResponse(200, {
    success: true,
    taskId: `task-${Date.now()}`,
    message: 'Task created',
  });
}

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
