import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});
const s3Client = new S3Client({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

/**
 * Patient data interfaces
 */
interface PatientProfile {
  patientId: string;
  recordType: string;
  phoneNumber?: string;
  email?: string;
  externalId?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  address?: Address;
  preferredChannel?: string;
  preferredLanguage?: string;
  insuranceInfo?: InsuranceInfo;
  emergencyContact?: EmergencyContact;
  consentStatus?: ConsentStatus;
  tags?: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface Address {
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zipCode: string;
  country?: string;
}

interface InsuranceInfo {
  provider: string;
  memberId: string;
  groupNumber?: string;
  planType?: string;
  isPrimary: boolean;
  verifiedAt?: string;
}

interface EmergencyContact {
  name: string;
  relationship: string;
  phoneNumber: string;
}

interface ConsentStatus {
  hipaaConsent: boolean;
  hipaaConsentDate?: string;
  marketingConsent: boolean;
  marketingConsentDate?: string;
  smsConsent: boolean;
  smsConsentDate?: string;
}

interface Patient360View {
  profile: PatientProfile;
  recentConversations: any[];
  upcomingAppointments: any[];
  recentInteractions: any[];
  documents: any[];
  metrics: PatientMetrics;
}

interface PatientMetrics {
  totalAppointments: number;
  completedAppointments: number;
  missedAppointments: number;
  totalInteractions: number;
  lastInteractionDate?: string;
  preferredContactTime?: string;
  engagementScore: number;
}

/**
 * Patient Service Lambda Handler
 *
 * This function handles all patient CRUD operations and the Patient 360 view.
 * It supports:
 * - Creating new patients
 * - Updating patient profiles
 * - Retrieving patient information
 * - Building the comprehensive 360 view
 * - Managing patient documents
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Patient Service Event:', JSON.stringify(event, null, 2));

  try {
    // Handle EventBridge events
    if (event.source === 'medcx.patients') {
      return handleEventBridgeEvent(event);
    }

    // Handle API Gateway requests
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const path = event.path || event.rawPath;
    const pathParameters = event.pathParameters || {};

    // Route based on method and path
    if (path?.includes('/360')) {
      return getPatient360View(pathParameters.patientId);
    }

    switch (httpMethod) {
      case 'POST':
        return createPatient(JSON.parse(event.body || '{}'));
      case 'GET':
        if (pathParameters.patientId) {
          return getPatient(pathParameters.patientId);
        }
        return listPatients(event.queryStringParameters || {});
      case 'PUT':
        return updatePatient(pathParameters.patientId, JSON.parse(event.body || '{}'));
      case 'DELETE':
        return deletePatient(pathParameters.patientId);
      default:
        return formatResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error in Patient Service:', error);
    return formatResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Handle EventBridge events for patient lifecycle
 */
async function handleEventBridgeEvent(event: any): Promise<any> {
  const detailType = event['detail-type'];
  const detail = event.detail;

  switch (detailType) {
    case 'PatientRegistered':
      // Send welcome message, create initial tasks, etc.
      console.log('New patient registered:', detail.patientId);
      await createWelcomeInteraction(detail.patientId);
      break;
    default:
      console.log('Unhandled event type:', detailType);
  }

  return { statusCode: 200, body: 'Event processed' };
}

/**
 * Create a new patient
 */
async function createPatient(data: Partial<PatientProfile>): Promise<any> {
  const patientId = data.patientId || randomUUID();
  const now = new Date().toISOString();

  const patient: PatientProfile = {
    patientId,
    recordType: 'PROFILE',
    phoneNumber: data.phoneNumber,
    email: data.email?.toLowerCase(),
    externalId: data.externalId,
    firstName: data.firstName,
    lastName: data.lastName,
    dateOfBirth: data.dateOfBirth,
    address: data.address,
    preferredChannel: data.preferredChannel || 'sms',
    preferredLanguage: data.preferredLanguage || 'en',
    insuranceInfo: data.insuranceInfo,
    emergencyContact: data.emergencyContact,
    consentStatus: data.consentStatus || {
      hipaaConsent: false,
      marketingConsent: false,
      smsConsent: true,
    },
    tags: data.tags || [],
    notes: data.notes,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: PATIENT_TABLE,
    Item: patient,
    ConditionExpression: 'attribute_not_exists(patientId)',
  }));

  // Emit patient created event
  await emitEvent('PatientCreated', {
    patientId,
    phoneNumber: patient.phoneNumber,
    email: patient.email,
    timestamp: now,
  });

  return formatResponse(201, patient);
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

  if (!result.Item) {
    return formatResponse(404, { error: 'Patient not found' });
  }

  return formatResponse(200, result.Item);
}

/**
 * List patients with pagination
 */
async function listPatients(queryParams: any): Promise<any> {
  const limit = parseInt(queryParams.limit) || 20;
  const lastKey = queryParams.lastKey ? JSON.parse(decodeURIComponent(queryParams.lastKey)) : undefined;

  // For listing, we need a scan or use a GSI
  // In production, you'd want to use a GSI with a status partition key
  const result = await docClient.send(new QueryCommand({
    TableName: PATIENT_TABLE,
    IndexName: 'phone-index',
    KeyConditionExpression: 'phoneNumber = :phone',
    ExpressionAttributeValues: {
      ':phone': queryParams.phoneNumber || '',
    },
    Limit: limit,
    ExclusiveStartKey: lastKey,
  }));

  return formatResponse(200, {
    patients: result.Items || [],
    lastKey: result.LastEvaluatedKey
      ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey))
      : null,
  });
}

/**
 * Update patient profile
 */
async function updatePatient(patientId: string, updates: Partial<PatientProfile>): Promise<any> {
  if (!patientId) {
    return formatResponse(400, { error: 'Patient ID is required' });
  }

  // Build update expression dynamically
  const updateExpressions: string[] = ['updatedAt = :updatedAt'];
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': new Date().toISOString(),
  };
  const expressionAttributeNames: Record<string, string> = {};

  const allowedFields = [
    'firstName', 'lastName', 'dateOfBirth', 'address', 'phoneNumber',
    'email', 'preferredChannel', 'preferredLanguage', 'insuranceInfo',
    'emergencyContact', 'consentStatus', 'tags', 'notes',
  ];

  for (const field of allowedFields) {
    if (updates[field as keyof PatientProfile] !== undefined) {
      updateExpressions.push(`#${field} = :${field}`);
      expressionAttributeValues[`:${field}`] = updates[field as keyof PatientProfile];
      expressionAttributeNames[`#${field}`] = field;
    }
  }

  const result = await docClient.send(new UpdateCommand({
    TableName: PATIENT_TABLE,
    Key: {
      patientId,
      recordType: 'PROFILE',
    },
    UpdateExpression: 'SET ' + updateExpressions.join(', '),
    ExpressionAttributeValues: expressionAttributeValues,
    ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0
      ? expressionAttributeNames
      : undefined,
    ReturnValues: 'ALL_NEW',
    ConditionExpression: 'attribute_exists(patientId)',
  }));

  // Emit patient updated event
  await emitEvent('PatientUpdated', {
    patientId,
    updatedFields: Object.keys(updates),
    timestamp: new Date().toISOString(),
  });

  return formatResponse(200, result.Attributes);
}

/**
 * Soft delete patient (mark as inactive)
 */
async function deletePatient(patientId: string): Promise<any> {
  if (!patientId) {
    return formatResponse(400, { error: 'Patient ID is required' });
  }

  // Soft delete - mark as inactive rather than hard delete
  await docClient.send(new UpdateCommand({
    TableName: PATIENT_TABLE,
    Key: {
      patientId,
      recordType: 'PROFILE',
    },
    UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':status': 'INACTIVE',
      ':updatedAt': new Date().toISOString(),
    },
    ConditionExpression: 'attribute_exists(patientId)',
  }));

  // Emit patient deactivated event
  await emitEvent('PatientDeactivated', {
    patientId,
    timestamp: new Date().toISOString(),
  });

  return formatResponse(200, { message: 'Patient deactivated successfully' });
}

/**
 * Get comprehensive Patient 360 view
 */
async function getPatient360View(patientId: string): Promise<any> {
  if (!patientId) {
    return formatResponse(400, { error: 'Patient ID is required' });
  }

  // Fetch all data in parallel for performance
  const [
    profileResult,
    conversationsResult,
    appointmentsResult,
    interactionsResult,
  ] = await Promise.all([
    // Get patient profile
    docClient.send(new GetCommand({
      TableName: PATIENT_TABLE,
      Key: {
        patientId,
        recordType: 'PROFILE',
      },
    })),
    // Get recent conversations
    docClient.send(new QueryCommand({
      TableName: CONVERSATION_TABLE,
      KeyConditionExpression: 'patientId = :patientId',
      ExpressionAttributeValues: {
        ':patientId': patientId,
      },
      ScanIndexForward: false, // Most recent first
      Limit: 10,
    })),
    // Get upcoming appointments
    docClient.send(new QueryCommand({
      TableName: APPOINTMENT_TABLE,
      IndexName: 'patient-index',
      KeyConditionExpression: 'patientId = :patientId AND appointmentDateTime >= :now',
      ExpressionAttributeValues: {
        ':patientId': patientId,
        ':now': new Date().toISOString(),
      },
      Limit: 5,
    })),
    // Get recent interactions
    docClient.send(new QueryCommand({
      TableName: INTERACTION_TABLE,
      KeyConditionExpression: 'patientId = :patientId',
      ExpressionAttributeValues: {
        ':patientId': patientId,
      },
      ScanIndexForward: false,
      Limit: 20,
    })),
  ]);

  if (!profileResult.Item) {
    return formatResponse(404, { error: 'Patient not found' });
  }

  // Calculate patient metrics
  const metrics = calculatePatientMetrics(
    appointmentsResult.Items || [],
    interactionsResult.Items || []
  );

  // Get document URLs
  const documents = await getPatientDocuments(patientId);

  const patient360View: Patient360View = {
    profile: profileResult.Item as PatientProfile,
    recentConversations: conversationsResult.Items || [],
    upcomingAppointments: appointmentsResult.Items || [],
    recentInteractions: interactionsResult.Items || [],
    documents,
    metrics,
  };

  return formatResponse(200, patient360View);
}

/**
 * Calculate patient engagement metrics
 */
function calculatePatientMetrics(appointments: any[], interactions: any[]): PatientMetrics {
  const completedAppointments = appointments.filter(a => a.status === 'COMPLETED').length;
  const missedAppointments = appointments.filter(a => a.status === 'MISSED' || a.status === 'NO_SHOW').length;

  // Calculate engagement score (0-100)
  let engagementScore = 50; // Base score

  // Positive factors
  if (completedAppointments > 0) engagementScore += 20;
  if (interactions.length > 5) engagementScore += 15;
  if (interactions.some(i => i.type === 'RESPONSE')) engagementScore += 10;

  // Negative factors
  if (missedAppointments > 0) engagementScore -= (missedAppointments * 10);
  if (interactions.length === 0) engagementScore -= 15;

  engagementScore = Math.max(0, Math.min(100, engagementScore));

  return {
    totalAppointments: appointments.length,
    completedAppointments,
    missedAppointments,
    totalInteractions: interactions.length,
    lastInteractionDate: interactions[0]?.interactionTimestamp,
    engagementScore,
  };
}

/**
 * Get patient document presigned URLs
 */
async function getPatientDocuments(patientId: string): Promise<any[]> {
  try {
    // Query for patient documents in DynamoDB
    const docsResult = await docClient.send(new QueryCommand({
      TableName: PATIENT_TABLE,
      KeyConditionExpression: 'patientId = :patientId AND begins_with(recordType, :prefix)',
      ExpressionAttributeValues: {
        ':patientId': patientId,
        ':prefix': 'DOC#',
      },
    }));

    // Generate presigned URLs for each document
    const documents = await Promise.all(
      (docsResult.Items || []).map(async (doc) => {
        const signedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: DOCUMENTS_BUCKET,
            Key: doc.s3Key,
          }),
          { expiresIn: 3600 } // 1 hour
        );

        return {
          documentId: doc.documentId,
          documentType: doc.documentType,
          fileName: doc.fileName,
          uploadedAt: doc.uploadedAt,
          url: signedUrl,
        };
      })
    );

    return documents;
  } catch (error) {
    console.error('Error fetching documents:', error);
    return [];
  }
}

/**
 * Create welcome interaction for new patient
 */
async function createWelcomeInteraction(patientId: string): Promise<void> {
  const interactionId = randomUUID();
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: INTERACTION_TABLE,
    Item: {
      patientId,
      interactionTimestamp: now,
      interactionId,
      interactionType: 'SYSTEM',
      subType: 'WELCOME',
      description: 'Patient registered in MedCX system',
      status: 'COMPLETED',
      createdAt: now,
    },
  }));
}

/**
 * Emit event to EventBridge
 */
async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [
      {
        EventBusName: EVENT_BUS_NAME,
        Source: 'medcx.patients',
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
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key',
    },
    body: JSON.stringify(body),
  };
}
