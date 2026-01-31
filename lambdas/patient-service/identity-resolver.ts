import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface IdentityRequest {
  phoneNumber?: string;
  email?: string;
  externalId?: string;
  channel?: string;
  createIfNotFound?: boolean;
  additionalData?: Record<string, any>;
}

interface PatientIdentity {
  patientId: string;
  phoneNumber?: string;
  email?: string;
  externalId?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  preferredChannel?: string;
  createdAt: string;
  updatedAt: string;
  isNew: boolean;
}

/**
 * Identity Resolver Lambda
 *
 * This function is the core of the unified patient identity system.
 * It resolves patient identity from various identifiers (phone, email, external ID)
 * and maintains a single source of truth for patient identity across all channels.
 *
 * Key features:
 * - Phone number is the primary identifier (most reliable for omnichannel)
 * - Email and external ID are secondary identifiers
 * - Automatic linking of identities when multiple identifiers match
 * - Optional patient creation for new contacts
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Identity Resolver Event:', JSON.stringify(event, null, 2));

  try {
    // Parse the request
    const request: IdentityRequest = typeof event.body === 'string'
      ? JSON.parse(event.body)
      : event.body || event;

    const { phoneNumber, email, externalId, channel, createIfNotFound, additionalData } = request;

    // Validate input - at least one identifier required
    if (!phoneNumber && !email && !externalId) {
      return formatResponse(400, {
        error: 'At least one identifier (phoneNumber, email, or externalId) is required',
      });
    }

    // Normalize phone number
    const normalizedPhone = phoneNumber ? normalizePhoneNumber(phoneNumber) : undefined;

    // Try to resolve identity in order of priority
    let patient: PatientIdentity | null = null;

    // 1. Try phone number first (primary identifier)
    if (normalizedPhone) {
      patient = await findPatientByIndex('phone-index', 'phoneNumber', normalizedPhone);
    }

    // 2. Try email if phone didn't match
    if (!patient && email) {
      patient = await findPatientByIndex('email-index', 'email', email.toLowerCase());
    }

    // 3. Try external ID
    if (!patient && externalId) {
      patient = await findPatientByIndex('externalId-index', 'externalId', externalId);
    }

    // If patient found, check for identity linking opportunities
    if (patient) {
      const updates = await linkAdditionalIdentifiers(patient, {
        phoneNumber: normalizedPhone,
        email: email?.toLowerCase(),
        externalId,
      });

      if (updates) {
        patient = { ...patient, ...updates, updatedAt: new Date().toISOString() };
      }

      // Update last interaction channel
      if (channel) {
        await updateLastChannel(patient.patientId, channel);
      }

      return formatResponse(200, {
        ...patient,
        isNew: false,
      });
    }

    // Patient not found - create if requested
    if (createIfNotFound) {
      const newPatient = await createPatient({
        phoneNumber: normalizedPhone,
        email: email?.toLowerCase(),
        externalId,
        channel,
        ...additionalData,
      });

      // Emit patient registered event
      await emitEvent('PatientRegistered', {
        patientId: newPatient.patientId,
        phoneNumber: normalizedPhone,
        email: email?.toLowerCase(),
        channel,
        timestamp: new Date().toISOString(),
      });

      return formatResponse(201, {
        ...newPatient,
        isNew: true,
      });
    }

    // Patient not found and not creating
    return formatResponse(404, {
      error: 'Patient not found',
      identifiers: { phoneNumber: normalizedPhone, email, externalId },
    });
  } catch (error) {
    console.error('Error resolving identity:', error);
    return formatResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * Normalize phone number to E.164 format
 */
function normalizePhoneNumber(phone: string): string {
  // Remove all non-digit characters
  let digits = phone.replace(/\D/g, '');

  // Handle US numbers
  if (digits.length === 10) {
    digits = '1' + digits;
  }

  // Add + prefix
  if (!digits.startsWith('+')) {
    digits = '+' + digits;
  }

  return digits;
}

/**
 * Find patient by GSI
 */
async function findPatientByIndex(
  indexName: string,
  keyName: string,
  keyValue: string
): Promise<PatientIdentity | null> {
  const command = new QueryCommand({
    TableName: PATIENT_TABLE,
    IndexName: indexName,
    KeyConditionExpression: `${keyName} = :value`,
    ExpressionAttributeValues: {
      ':value': keyValue,
    },
    Limit: 1,
  });

  const result = await docClient.send(command);

  if (result.Items && result.Items.length > 0) {
    const item = result.Items[0];
    return {
      patientId: item.patientId,
      phoneNumber: item.phoneNumber,
      email: item.email,
      externalId: item.externalId,
      firstName: item.firstName,
      lastName: item.lastName,
      dateOfBirth: item.dateOfBirth,
      preferredChannel: item.preferredChannel,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isNew: false,
    };
  }

  return null;
}

/**
 * Link additional identifiers to existing patient
 */
async function linkAdditionalIdentifiers(
  patient: PatientIdentity,
  identifiers: { phoneNumber?: string; email?: string; externalId?: string }
): Promise<Partial<PatientIdentity> | null> {
  const updates: Record<string, any> = {};

  // Link phone if patient doesn't have one
  if (identifiers.phoneNumber && !patient.phoneNumber) {
    updates.phoneNumber = identifiers.phoneNumber;
  }

  // Link email if patient doesn't have one
  if (identifiers.email && !patient.email) {
    updates.email = identifiers.email;
  }

  // Link external ID if patient doesn't have one
  if (identifiers.externalId && !patient.externalId) {
    updates.externalId = identifiers.externalId;
  }

  // If any updates, save them
  if (Object.keys(updates).length > 0) {
    const updateExpression = Object.keys(updates)
      .map((key) => `${key} = :${key}`)
      .join(', ');

    const expressionAttributeValues = Object.entries(updates).reduce(
      (acc, [key, value]) => ({ ...acc, [`:${key}`]: value }),
      { ':updatedAt': new Date().toISOString() }
    );

    // Note: Using PutCommand with full item for simplicity
    // In production, use UpdateCommand for partial updates
    const getCommand = new GetCommand({
      TableName: PATIENT_TABLE,
      Key: {
        patientId: patient.patientId,
        recordType: 'PROFILE',
      },
    });

    const existing = await docClient.send(getCommand);
    if (existing.Item) {
      const command = new PutCommand({
        TableName: PATIENT_TABLE,
        Item: {
          ...existing.Item,
          ...updates,
          updatedAt: new Date().toISOString(),
        },
      });

      await docClient.send(command);

      // Emit identity linked event
      await emitEvent('IdentityLinked', {
        patientId: patient.patientId,
        linkedIdentifiers: updates,
        timestamp: new Date().toISOString(),
      });
    }

    return updates;
  }

  return null;
}

/**
 * Update patient's last interaction channel
 */
async function updateLastChannel(patientId: string, channel: string): Promise<void> {
  const getCommand = new GetCommand({
    TableName: PATIENT_TABLE,
    Key: {
      patientId,
      recordType: 'PROFILE',
    },
  });

  const existing = await docClient.send(getCommand);
  if (existing.Item) {
    const command = new PutCommand({
      TableName: PATIENT_TABLE,
      Item: {
        ...existing.Item,
        lastChannel: channel,
        lastInteraction: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    await docClient.send(command);
  }
}

/**
 * Create new patient record
 */
async function createPatient(data: {
  phoneNumber?: string;
  email?: string;
  externalId?: string;
  channel?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
}): Promise<PatientIdentity> {
  const patientId = randomUUID();
  const now = new Date().toISOString();

  const patient: PatientIdentity & { recordType: string } = {
    patientId,
    recordType: 'PROFILE',
    phoneNumber: data.phoneNumber,
    email: data.email,
    externalId: data.externalId,
    firstName: data.firstName,
    lastName: data.lastName,
    dateOfBirth: data.dateOfBirth,
    preferredChannel: data.channel || 'sms',
    createdAt: now,
    updatedAt: now,
    isNew: true,
  };

  const command = new PutCommand({
    TableName: PATIENT_TABLE,
    Item: patient,
  });

  await docClient.send(command);

  return patient;
}

/**
 * Emit event to EventBridge
 */
async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  const command = new PutEventsCommand({
    Entries: [
      {
        EventBusName: EVENT_BUS_NAME,
        Source: 'medcx.identity',
        DetailType: detailType,
        Detail: JSON.stringify(detail),
      },
    ],
  });

  await eventBridge.send(command);
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
