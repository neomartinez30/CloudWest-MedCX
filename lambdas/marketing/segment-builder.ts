import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});

const SEGMENT_TABLE = process.env.SEGMENT_TABLE!;
const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

type SegmentType = 'static' | 'dynamic';
type ConditionOperator = 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than' | 'between' | 'in' | 'before' | 'after';

interface SegmentCondition {
  field: string;
  operator: ConditionOperator;
  value: any;
}

interface Segment {
  segmentId: string;
  name: string;
  description?: string;
  segmentType: SegmentType;
  conditions?: {
    logic: 'AND' | 'OR';
    rules: SegmentCondition[];
  };
  patientIds?: string[];
  estimatedSize?: number;
  lastCalculated?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Segment Builder Lambda
 *
 * Creates and manages patient segments for targeted outreach:
 * - Build dynamic segments with rules
 * - Create static lists
 * - Calculate segment membership
 * - Support complex conditions
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Segment Builder Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...data } = event;

    switch (action) {
      case 'createSegment':
        return createSegment(data);

      case 'updateSegment':
        return updateSegment(data);

      case 'getSegment':
        return getSegment(data.segmentId);

      case 'listSegments':
        return listSegments(data);

      case 'deleteSegment':
        return deleteSegment(data.segmentId);

      case 'calculateSegment':
        return calculateSegment(data.segmentId);

      case 'getSegmentMembers':
        return getSegmentMembers(data.segmentId, data.limit);

      case 'addToSegment':
        return addToSegment(data.segmentId, data.patientIds);

      case 'removeFromSegment':
        return removeFromSegment(data.segmentId, data.patientIds);

      case 'previewSegment':
        return previewSegment(data.conditions);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in segment builder:', error);
    return {
      error: 'Segment operation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Create a new segment
 */
async function createSegment(data: Partial<Segment>): Promise<any> {
  const segmentId = randomUUID();
  const now = new Date().toISOString();

  const segment: Segment = {
    segmentId,
    name: data.name || 'Untitled Segment',
    description: data.description,
    segmentType: data.segmentType || 'dynamic',
    conditions: data.conditions,
    patientIds: data.patientIds || [],
    estimatedSize: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Calculate initial size for dynamic segments
  if (segment.segmentType === 'dynamic' && segment.conditions) {
    const members = await evaluateConditions(segment.conditions);
    segment.estimatedSize = members.length;
    segment.patientIds = members.map((m: any) => m.patientId);
    segment.lastCalculated = now;
  } else if (segment.patientIds) {
    segment.estimatedSize = segment.patientIds.length;
  }

  await docClient.send(new PutCommand({
    TableName: SEGMENT_TABLE,
    Item: segment,
  }));

  await emitEvent('SegmentCreated', {
    segmentId,
    name: segment.name,
    type: segment.segmentType,
    size: segment.estimatedSize,
    timestamp: now,
  });

  return {
    success: true,
    segmentId,
    segment,
  };
}

/**
 * Update segment
 */
async function updateSegment(data: { segmentId: string } & Partial<Segment>): Promise<any> {
  const { segmentId, ...updates } = data;
  const now = new Date().toISOString();

  // If conditions are updated, recalculate
  if (updates.conditions) {
    const members = await evaluateConditions(updates.conditions);
    updates.patientIds = members.map((m: any) => m.patientId);
    updates.estimatedSize = members.length;
    updates.lastCalculated = now;
  }

  const updateParts: string[] = ['updatedAt = :updated'];
  const expressionValues: any = { ':updated': now };
  const expressionNames: any = {};

  for (const [key, value] of Object.entries(updates)) {
    if (key !== 'segmentId' && value !== undefined) {
      const attrName = `#${key}`;
      const attrValue = `:${key}`;
      expressionNames[attrName] = key;
      expressionValues[attrValue] = value;
      updateParts.push(`${attrName} = ${attrValue}`);
    }
  }

  await docClient.send(new UpdateCommand({
    TableName: SEGMENT_TABLE,
    Key: { segmentId },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeNames: Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
    ExpressionAttributeValues: expressionValues,
  }));

  return {
    success: true,
    segmentId,
    estimatedSize: updates.estimatedSize,
  };
}

/**
 * Get segment
 */
async function getSegment(segmentId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: SEGMENT_TABLE,
    Key: { segmentId },
  }));

  if (!result.Item) {
    return { error: 'Segment not found' };
  }

  return result.Item;
}

/**
 * List segments
 */
async function listSegments(params: {
  segmentType?: SegmentType;
  limit?: number;
}): Promise<any> {
  const { segmentType, limit = 50 } = params;

  let filterExpression: string | undefined;
  const expressionValues: any = {};

  if (segmentType) {
    filterExpression = 'segmentType = :segmentType';
    expressionValues[':segmentType'] = segmentType;
  }

  const result = await docClient.send(new ScanCommand({
    TableName: SEGMENT_TABLE,
    FilterExpression: filterExpression,
    ExpressionAttributeValues: Object.keys(expressionValues).length > 0 ? expressionValues : undefined,
    Limit: limit,
  }));

  return {
    segments: result.Items || [],
    count: result.Items?.length || 0,
  };
}

/**
 * Delete segment
 */
async function deleteSegment(segmentId: string): Promise<any> {
  await docClient.send(new UpdateCommand({
    TableName: SEGMENT_TABLE,
    Key: { segmentId },
    UpdateExpression: 'SET deleted = :deleted, deletedAt = :deletedAt',
    ExpressionAttributeValues: {
      ':deleted': true,
      ':deletedAt': new Date().toISOString(),
    },
  }));

  return { success: true, segmentId };
}

/**
 * Calculate/refresh segment membership
 */
async function calculateSegment(segmentId: string): Promise<any> {
  const segment = await getSegment(segmentId);

  if (segment.error) {
    return segment;
  }

  if (segment.segmentType !== 'dynamic') {
    return { error: 'Can only calculate dynamic segments' };
  }

  const now = new Date().toISOString();
  const members = await evaluateConditions(segment.conditions);

  await docClient.send(new UpdateCommand({
    TableName: SEGMENT_TABLE,
    Key: { segmentId },
    UpdateExpression: 'SET patientIds = :patientIds, estimatedSize = :size, lastCalculated = :calculated, updatedAt = :updated',
    ExpressionAttributeValues: {
      ':patientIds': members.map((m: any) => m.patientId),
      ':size': members.length,
      ':calculated': now,
      ':updated': now,
    },
  }));

  await emitEvent('SegmentCalculated', {
    segmentId,
    size: members.length,
    timestamp: now,
  });

  return {
    success: true,
    segmentId,
    memberCount: members.length,
    lastCalculated: now,
  };
}

/**
 * Get segment members
 */
async function getSegmentMembers(segmentId: string, limit = 100): Promise<any> {
  const segment = await getSegment(segmentId);

  if (segment.error) {
    return segment;
  }

  const patientIds = (segment.patientIds || []).slice(0, limit);

  // Get patient details
  const patients = await Promise.all(
    patientIds.map(async (patientId: string) => {
      const result = await docClient.send(new GetCommand({
        TableName: PATIENT_TABLE,
        Key: { patientId, recordType: 'PROFILE' },
      }));
      return result.Item;
    })
  );

  return {
    segmentId,
    members: patients.filter(Boolean),
    totalCount: segment.estimatedSize || segment.patientIds?.length || 0,
    returnedCount: patients.filter(Boolean).length,
  };
}

/**
 * Add patients to static segment
 */
async function addToSegment(segmentId: string, patientIds: string[]): Promise<any> {
  const segment = await getSegment(segmentId);

  if (segment.error) {
    return segment;
  }

  if (segment.segmentType !== 'static') {
    return { error: 'Can only add to static segments' };
  }

  const currentIds = new Set(segment.patientIds || []);
  patientIds.forEach(id => currentIds.add(id));

  const newPatientIds = Array.from(currentIds);

  await docClient.send(new UpdateCommand({
    TableName: SEGMENT_TABLE,
    Key: { segmentId },
    UpdateExpression: 'SET patientIds = :patientIds, estimatedSize = :size, updatedAt = :updated',
    ExpressionAttributeValues: {
      ':patientIds': newPatientIds,
      ':size': newPatientIds.length,
      ':updated': new Date().toISOString(),
    },
  }));

  return {
    success: true,
    segmentId,
    added: patientIds.length,
    newSize: newPatientIds.length,
  };
}

/**
 * Remove patients from static segment
 */
async function removeFromSegment(segmentId: string, patientIds: string[]): Promise<any> {
  const segment = await getSegment(segmentId);

  if (segment.error) {
    return segment;
  }

  if (segment.segmentType !== 'static') {
    return { error: 'Can only remove from static segments' };
  }

  const currentIds = new Set(segment.patientIds || []);
  patientIds.forEach(id => currentIds.delete(id));

  const newPatientIds = Array.from(currentIds);

  await docClient.send(new UpdateCommand({
    TableName: SEGMENT_TABLE,
    Key: { segmentId },
    UpdateExpression: 'SET patientIds = :patientIds, estimatedSize = :size, updatedAt = :updated',
    ExpressionAttributeValues: {
      ':patientIds': newPatientIds,
      ':size': newPatientIds.length,
      ':updated': new Date().toISOString(),
    },
  }));

  return {
    success: true,
    segmentId,
    removed: patientIds.length,
    newSize: newPatientIds.length,
  };
}

/**
 * Preview segment without saving
 */
async function previewSegment(conditions: Segment['conditions']): Promise<any> {
  if (!conditions) {
    return { error: 'Conditions required' };
  }

  const members = await evaluateConditions(conditions);

  return {
    estimatedSize: members.length,
    sampleMembers: members.slice(0, 10).map((m: any) => ({
      patientId: m.patientId,
      name: `${m.firstName || ''} ${m.lastName || ''}`.trim(),
      email: m.email,
      phoneNumber: m.phoneNumber,
    })),
  };
}

/**
 * Evaluate segment conditions against patient data
 */
async function evaluateConditions(conditions: Segment['conditions']): Promise<any[]> {
  if (!conditions || !conditions.rules || conditions.rules.length === 0) {
    return [];
  }

  // Build DynamoDB filter from conditions
  // In production, would use OpenSearch for complex queries

  const result = await docClient.send(new ScanCommand({
    TableName: PATIENT_TABLE,
    FilterExpression: 'recordType = :profile',
    ExpressionAttributeValues: { ':profile': 'PROFILE' },
    Limit: 10000,
  }));

  const patients = result.Items || [];

  // Apply conditions in memory
  return patients.filter(patient => {
    const results = conditions.rules.map(rule => evaluateRule(patient, rule));

    if (conditions.logic === 'AND') {
      return results.every(r => r);
    } else {
      return results.some(r => r);
    }
  });
}

/**
 * Evaluate a single rule against a patient
 */
function evaluateRule(patient: any, rule: SegmentCondition): boolean {
  const value = getNestedValue(patient, rule.field);

  switch (rule.operator) {
    case 'equals':
      return value === rule.value;

    case 'not_equals':
      return value !== rule.value;

    case 'contains':
      return typeof value === 'string' && value.toLowerCase().includes(String(rule.value).toLowerCase());

    case 'greater_than':
      return Number(value) > Number(rule.value);

    case 'less_than':
      return Number(value) < Number(rule.value);

    case 'between':
      const num = Number(value);
      return num >= Number(rule.value[0]) && num <= Number(rule.value[1]);

    case 'in':
      return Array.isArray(rule.value) && rule.value.includes(value);

    case 'before':
      return new Date(value) < new Date(rule.value);

    case 'after':
      return new Date(value) > new Date(rule.value);

    default:
      return false;
  }
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [{
      EventBusName: EVENT_BUS_NAME,
      Source: 'medcx.segments',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
