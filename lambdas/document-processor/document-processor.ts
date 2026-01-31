import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { TextractClient, AnalyzeDocumentCommand, FeatureType } from '@aws-sdk/client-textract';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const textractClient = new TextractClient({});
const eventBridge = new EventBridgeClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface DocumentEvent {
  action?: 'processDocument' | 'getUploadUrl' | 'getDocument';
  patientId: string;
  documentType: 'insurance_card' | 'id_document' | 'other';
  s3Key?: string;
  fileName?: string;
  contentType?: string;
}

interface S3Event {
  Records: Array<{
    s3: {
      bucket: { name: string };
      object: { key: string };
    };
  }>;
}

/**
 * Document Processor Lambda
 *
 * Handles document uploads and processing:
 * - Generate presigned URLs for secure uploads
 * - Process uploaded insurance cards and IDs using Textract
 * - Extract and store structured data
 * - Trigger verification workflows
 */
export const handler = async (event: DocumentEvent | S3Event | any): Promise<any> => {
  console.log('Document Processor Event:', JSON.stringify(event, null, 2));

  try {
    // Handle S3 trigger events (new document uploaded)
    if (event.Records && event.Records[0]?.s3) {
      return handleS3Upload(event as S3Event);
    }

    // Handle API Gateway events
    if (event.httpMethod) {
      return handleApiRequest(event);
    }

    // Handle direct invocations
    const request = event as DocumentEvent;

    switch (request.action) {
      case 'getUploadUrl':
        return generateUploadUrl(request);

      case 'processDocument':
        return processDocument(request);

      case 'getDocument':
        return getDocument(request.patientId, request.documentType);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in document processor:', error);
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
  const { httpMethod, body, pathParameters, queryStringParameters } = event;
  const patientId = pathParameters?.patientId;
  const data = body ? JSON.parse(body) : {};

  switch (httpMethod) {
    case 'GET':
      // Get document or upload URL
      if (queryStringParameters?.action === 'upload') {
        return formatResponse(200, await generateUploadUrl({
          patientId,
          documentType: queryStringParameters.documentType as any,
          fileName: queryStringParameters.fileName,
          contentType: queryStringParameters.contentType,
        }));
      }
      return formatResponse(200, await getDocument(patientId, data.documentType));

    case 'POST':
      // Process uploaded document
      return formatResponse(200, await processDocument({
        patientId,
        documentType: data.documentType,
        s3Key: data.s3Key,
      }));

    default:
      return formatResponse(405, { error: 'Method not allowed' });
  }
}

/**
 * Handle S3 upload trigger
 */
async function handleS3Upload(event: S3Event): Promise<any> {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

  console.log(`Processing uploaded document: ${bucket}/${key}`);

  // Parse the S3 key to extract patient ID and document type
  // Expected format: documents/{patientId}/{documentType}/{filename}
  const keyParts = key.split('/');
  if (keyParts.length < 4 || keyParts[0] !== 'documents') {
    console.log('Skipping non-document file:', key);
    return { message: 'Skipped' };
  }

  const patientId = keyParts[1];
  const documentType = keyParts[2] as 'insurance_card' | 'id_document' | 'other';

  // Process the document
  return processDocument({
    patientId,
    documentType,
    s3Key: key,
  });
}

/**
 * Generate presigned URL for document upload
 */
async function generateUploadUrl(request: DocumentEvent): Promise<any> {
  const { patientId, documentType, fileName, contentType = 'image/jpeg' } = request;

  if (!patientId || !documentType) {
    return { error: 'patientId and documentType are required' };
  }

  const fileExtension = fileName?.split('.').pop() || 'jpg';
  const s3Key = `documents/${patientId}/${documentType}/${uuidv4()}.${fileExtension}`;

  const command = new PutObjectCommand({
    Bucket: DOCUMENTS_BUCKET,
    Key: s3Key,
    ContentType: contentType,
    Metadata: {
      patientId,
      documentType,
      originalFileName: fileName || 'unknown',
    },
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

  return {
    uploadUrl,
    s3Key,
    expiresIn: 3600,
    instructions: 'PUT the file directly to this URL with the specified Content-Type header',
  };
}

/**
 * Process an uploaded document using Textract
 */
async function processDocument(request: DocumentEvent): Promise<any> {
  const { patientId, documentType, s3Key } = request;

  if (!patientId || !documentType || !s3Key) {
    return { error: 'patientId, documentType, and s3Key are required' };
  }

  const now = new Date().toISOString();
  const documentId = uuidv4();

  // Call Textract to analyze the document
  const textractResult = await analyzeDocument(s3Key);

  // Extract structured data based on document type
  let extractedData: any = {};
  let verificationStatus = 'pending';

  if (documentType === 'insurance_card') {
    extractedData = extractInsuranceData(textractResult);
    verificationStatus = extractedData.insurerId ? 'extracted' : 'needs_review';
  } else if (documentType === 'id_document') {
    extractedData = extractIdData(textractResult);
    verificationStatus = extractedData.documentNumber ? 'extracted' : 'needs_review';
  } else {
    extractedData = {
      rawText: textractResult.rawText,
      keyValuePairs: textractResult.keyValuePairs,
    };
  }

  // Store document record in patient table
  await docClient.send(new PutCommand({
    TableName: PATIENT_TABLE,
    Item: {
      patientId,
      recordType: `DOCUMENT#${documentType}#${documentId}`,
      documentId,
      documentType,
      s3Key,
      extractedData,
      verificationStatus,
      textractJobId: textractResult.jobId,
      rawTextractResult: textractResult,
      uploadedAt: now,
      processedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  }));

  // Update patient profile with insurance/ID info if extracted
  if (verificationStatus === 'extracted') {
    await updatePatientWithDocumentData(patientId, documentType, extractedData);
  }

  // Emit event
  await emitEvent('DocumentProcessed', {
    patientId,
    documentId,
    documentType,
    verificationStatus,
    timestamp: now,
  });

  return {
    success: true,
    documentId,
    documentType,
    extractedData,
    verificationStatus,
    message: verificationStatus === 'extracted'
      ? 'Document processed successfully'
      : 'Document needs manual review',
  };
}

/**
 * Analyze document using Amazon Textract
 */
async function analyzeDocument(s3Key: string): Promise<any> {
  const command = new AnalyzeDocumentCommand({
    Document: {
      S3Object: {
        Bucket: DOCUMENTS_BUCKET,
        Name: s3Key,
      },
    },
    FeatureTypes: [FeatureType.FORMS, FeatureType.TABLES],
  });

  const response = await textractClient.send(command);

  // Extract raw text
  const rawText = response.Blocks
    ?.filter(block => block.BlockType === 'LINE')
    .map(block => block.Text)
    .join('\n') || '';

  // Extract key-value pairs
  const keyValuePairs: Record<string, string> = {};
  const keyBlocks = response.Blocks?.filter(block => block.BlockType === 'KEY_VALUE_SET' && block.EntityTypes?.includes('KEY')) || [];

  for (const keyBlock of keyBlocks) {
    const keyText = getBlockText(response.Blocks || [], keyBlock);
    const valueBlock = response.Blocks?.find(
      block => block.BlockType === 'KEY_VALUE_SET' &&
        block.EntityTypes?.includes('VALUE') &&
        keyBlock.Relationships?.some(rel =>
          rel.Type === 'VALUE' && rel.Ids?.includes(block.Id || '')
        )
    );
    const valueText = valueBlock ? getBlockText(response.Blocks || [], valueBlock) : '';

    if (keyText && valueText) {
      keyValuePairs[keyText.toLowerCase().replace(/[:\s]+$/, '')] = valueText;
    }
  }

  return {
    rawText,
    keyValuePairs,
    blockCount: response.Blocks?.length || 0,
    jobId: response.$metadata.requestId,
  };
}

/**
 * Get text content from a Textract block
 */
function getBlockText(blocks: any[], block: any): string {
  if (!block.Relationships) return '';

  const childIds = block.Relationships
    .filter((rel: any) => rel.Type === 'CHILD')
    .flatMap((rel: any) => rel.Ids || []);

  return blocks
    .filter(b => childIds.includes(b.Id) && b.BlockType === 'WORD')
    .map(b => b.Text)
    .join(' ');
}

/**
 * Extract insurance card data from Textract results
 */
function extractInsuranceData(textractResult: any): any {
  const { keyValuePairs, rawText } = textractResult;
  const lowerText = rawText.toLowerCase();

  // Common insurance card fields
  const data: any = {
    insurerId: null,
    memberId: null,
    groupNumber: null,
    memberName: null,
    effectiveDate: null,
    copay: null,
    planType: null,
  };

  // Try to extract from key-value pairs
  for (const [key, value] of Object.entries(keyValuePairs)) {
    const lowerKey = key.toLowerCase();

    if (lowerKey.includes('member') && lowerKey.includes('id')) {
      data.memberId = value;
    } else if (lowerKey.includes('group')) {
      data.groupNumber = value;
    } else if (lowerKey.includes('name') || lowerKey.includes('member')) {
      data.memberName = value;
    } else if (lowerKey.includes('effective') || lowerKey.includes('date')) {
      data.effectiveDate = value;
    } else if (lowerKey.includes('copay') || lowerKey.includes('co-pay')) {
      data.copay = value;
    }
  }

  // Try to identify insurance company
  const insurers = ['aetna', 'cigna', 'united', 'blue cross', 'humana', 'kaiser', 'anthem'];
  for (const insurer of insurers) {
    if (lowerText.includes(insurer)) {
      data.insurerId = insurer.charAt(0).toUpperCase() + insurer.slice(1);
      break;
    }
  }

  return data;
}

/**
 * Extract ID document data from Textract results
 */
function extractIdData(textractResult: any): any {
  const { keyValuePairs, rawText } = textractResult;

  const data: any = {
    documentNumber: null,
    firstName: null,
    lastName: null,
    dateOfBirth: null,
    expirationDate: null,
    address: null,
    state: null,
    documentType: null,
  };

  // Determine document type
  const lowerText = rawText.toLowerCase();
  if (lowerText.includes('driver') || lowerText.includes('license')) {
    data.documentType = 'drivers_license';
  } else if (lowerText.includes('passport')) {
    data.documentType = 'passport';
  } else if (lowerText.includes('state id') || lowerText.includes('identification')) {
    data.documentType = 'state_id';
  }

  // Extract from key-value pairs
  for (const [key, value] of Object.entries(keyValuePairs)) {
    const lowerKey = key.toLowerCase();

    if (lowerKey.includes('dl') || lowerKey.includes('license') || lowerKey.includes('number')) {
      if (!data.documentNumber) data.documentNumber = value;
    } else if (lowerKey.includes('first') || lowerKey.includes('fn')) {
      data.firstName = value;
    } else if (lowerKey.includes('last') || lowerKey.includes('ln')) {
      data.lastName = value;
    } else if (lowerKey.includes('dob') || lowerKey.includes('birth')) {
      data.dateOfBirth = value;
    } else if (lowerKey.includes('exp')) {
      data.expirationDate = value;
    } else if (lowerKey.includes('address') || lowerKey.includes('addr')) {
      data.address = value;
    }
  }

  return data;
}

/**
 * Update patient profile with extracted document data
 */
async function updatePatientWithDocumentData(
  patientId: string,
  documentType: string,
  extractedData: any
): Promise<void> {
  const updateExpression: string[] = ['updatedAt = :now'];
  const expressionAttributeValues: Record<string, any> = {
    ':now': new Date().toISOString(),
  };

  if (documentType === 'insurance_card' && extractedData.memberId) {
    updateExpression.push('insuranceMemberId = :memberId');
    updateExpression.push('insuranceGroupNumber = :groupNumber');
    updateExpression.push('insuranceProvider = :provider');
    expressionAttributeValues[':memberId'] = extractedData.memberId;
    expressionAttributeValues[':groupNumber'] = extractedData.groupNumber;
    expressionAttributeValues[':provider'] = extractedData.insurerId;
  }

  if (documentType === 'id_document' && extractedData.documentNumber) {
    updateExpression.push('idDocumentNumber = :idNumber');
    updateExpression.push('idDocumentType = :idType');
    if (extractedData.dateOfBirth && !extractedData.dateOfBirth.includes('*')) {
      updateExpression.push('dateOfBirth = :dob');
      expressionAttributeValues[':dob'] = extractedData.dateOfBirth;
    }
    expressionAttributeValues[':idNumber'] = extractedData.documentNumber;
    expressionAttributeValues[':idType'] = extractedData.documentType;
  }

  if (updateExpression.length > 1) {
    await docClient.send(new UpdateCommand({
      TableName: PATIENT_TABLE,
      Key: {
        patientId,
        recordType: 'PROFILE',
      },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
    }));
  }
}

/**
 * Get document for a patient
 */
async function getDocument(patientId: string, documentType: string): Promise<any> {
  // Query for the latest document of this type
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: {
      patientId,
      recordType: `DOCUMENT#${documentType}`,
    },
  }));

  if (!result.Item) {
    return { error: 'Document not found' };
  }

  // Generate presigned URL for viewing
  const viewUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: DOCUMENTS_BUCKET,
      Key: result.Item.s3Key,
    }),
    { expiresIn: 3600 }
  );

  return {
    ...result.Item,
    viewUrl,
    rawTextractResult: undefined, // Don't return raw Textract data
  };
}

/**
 * Emit event to EventBridge
 */
async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [
      {
        EventBusName: EVENT_BUS_NAME,
        Source: 'medcx.documents',
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
