import { TextractClient, AnalyzeDocumentCommand, DetectDocumentTextCommand, AnalyzeIDCommand } from '@aws-sdk/client-textract';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const textractClient = new TextractClient({});
const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});
const eventBridge = new EventBridgeClient({});

const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET!;
const DOCUMENT_TABLE = process.env.DOCUMENT_TABLE!;
const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const INSURANCE_VERIFIER_ARN = process.env.INSURANCE_VERIFIER_ARN!;
const ID_VERIFIER_ARN = process.env.ID_VERIFIER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

type DocumentType = 'insurance_card' | 'id_card' | 'medical_record' | 'form' | 'other';

interface DocumentProcessingRequest {
  patientId: string;
  documentType: DocumentType;
  s3Key: string;
  metadata?: Record<string, any>;
}

interface ExtractedData {
  documentType: DocumentType;
  confidence: number;
  fields: Record<string, { value: string; confidence: number }>;
  rawText?: string;
}

/**
 * Document Processor Lambda
 *
 * Processes uploaded documents using Amazon Textract:
 * - Insurance card OCR and data extraction
 * - ID card verification
 * - Medical form processing
 * - Automatic field mapping
 * - Patient record updates
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Document Processor Event:', JSON.stringify(event, null, 2));

  try {
    // Handle S3 triggers
    if (event.Records?.[0]?.s3) {
      return handleS3Event(event);
    }

    const { action, ...data } = event;

    switch (action) {
      case 'processDocument':
        return processDocument(data);

      case 'extractText':
        return extractText(data.s3Key);

      case 'analyzeInsuranceCard':
        return analyzeInsuranceCard(data);

      case 'analyzeIdCard':
        return analyzeIdCard(data);

      case 'getDocumentStatus':
        return getDocumentStatus(data.documentId);

      case 'getPatientDocuments':
        return getPatientDocuments(data.patientId);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in document processor:', error);
    return {
      error: 'Document processing failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Handle S3 upload events
 */
async function handleS3Event(event: any): Promise<any> {
  const results = [];

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Parse key to get patient ID and document type
    // Expected format: uploads/{patientId}/{documentType}/{filename}
    const keyParts = key.split('/');
    if (keyParts.length >= 4 && keyParts[0] === 'uploads') {
      const patientId = keyParts[1];
      const documentType = keyParts[2] as DocumentType;

      const result = await processDocument({
        patientId,
        documentType,
        s3Key: key,
      });

      results.push(result);
    }
  }

  return { processed: results.length, results };
}

/**
 * Process a document
 */
async function processDocument(request: DocumentProcessingRequest): Promise<any> {
  const { patientId, documentType, s3Key, metadata } = request;
  const documentId = randomUUID();
  const now = new Date().toISOString();

  // Create document record
  await docClient.send(new PutCommand({
    TableName: DOCUMENT_TABLE,
    Item: {
      documentId,
      patientId,
      documentType,
      s3Key,
      status: 'processing',
      metadata,
      createdAt: now,
      updatedAt: now,
    },
  }));

  let extractedData: ExtractedData;
  let verificationResult: any = null;

  try {
    // Process based on document type
    switch (documentType) {
      case 'insurance_card':
        extractedData = await analyzeInsuranceCard({ patientId, s3Key });
        // Trigger insurance verification
        verificationResult = await invokeFunction(INSURANCE_VERIFIER_ARN, {
          action: 'verifyInsurance',
          patientId,
          insuranceData: extractedData.fields,
        });
        break;

      case 'id_card':
        extractedData = await analyzeIdCard({ patientId, s3Key });
        // Trigger ID verification
        verificationResult = await invokeFunction(ID_VERIFIER_ARN, {
          action: 'verifyId',
          patientId,
          idData: extractedData.fields,
        });
        break;

      case 'medical_record':
        extractedData = await analyzeForm(s3Key);
        break;

      default:
        extractedData = await extractText(s3Key);
    }

    // Update document record with results
    await docClient.send(new UpdateCommand({
      TableName: DOCUMENT_TABLE,
      Key: { documentId },
      UpdateExpression: 'SET #status = :status, extractedData = :data, verificationResult = :verification, updatedAt = :updated',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'completed',
        ':data': extractedData,
        ':verification': verificationResult,
        ':updated': new Date().toISOString(),
      },
    }));

    // Emit event
    await emitEvent('DocumentProcessed', {
      documentId,
      patientId,
      documentType,
      success: true,
      timestamp: now,
    });

    return {
      success: true,
      documentId,
      documentType,
      extractedData,
      verificationResult,
    };
  } catch (error) {
    // Update with error status
    await docClient.send(new UpdateCommand({
      TableName: DOCUMENT_TABLE,
      Key: { documentId },
      UpdateExpression: 'SET #status = :status, errorMessage = :error, updatedAt = :updated',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'failed',
        ':error': error instanceof Error ? error.message : 'Unknown error',
        ':updated': new Date().toISOString(),
      },
    }));

    throw error;
  }
}

/**
 * Extract raw text from document
 */
async function extractText(s3Key: string): Promise<ExtractedData> {
  const command = new DetectDocumentTextCommand({
    Document: {
      S3Object: {
        Bucket: DOCUMENTS_BUCKET,
        Name: s3Key,
      },
    },
  });

  const response = await textractClient.send(command);

  const lines = response.Blocks?.filter(b => b.BlockType === 'LINE') || [];
  const rawText = lines.map(l => l.Text).join('\n');

  return {
    documentType: 'other',
    confidence: 0.9,
    fields: {},
    rawText,
  };
}

/**
 * Analyze insurance card
 */
async function analyzeInsuranceCard(data: {
  patientId: string;
  s3Key: string;
}): Promise<ExtractedData> {
  const { s3Key } = data;

  const command = new AnalyzeDocumentCommand({
    Document: {
      S3Object: {
        Bucket: DOCUMENTS_BUCKET,
        Name: s3Key,
      },
    },
    FeatureTypes: ['FORMS', 'TABLES'],
  });

  const response = await textractClient.send(command);

  // Extract key-value pairs
  const keyValuePairs = extractKeyValuePairs(response.Blocks || []);

  // Map to insurance fields
  const insuranceFields: Record<string, { value: string; confidence: number }> = {};

  const fieldMappings: Record<string, string[]> = {
    memberId: ['member id', 'member #', 'id #', 'subscriber id', 'member number'],
    groupNumber: ['group', 'group #', 'group number', 'grp'],
    planName: ['plan', 'plan name', 'insurance plan'],
    memberName: ['name', 'member name', 'subscriber name', 'insured name'],
    effectiveDate: ['effective', 'effective date', 'eff date'],
    copay: ['copay', 'co-pay', 'office visit', 'pcp copay'],
    rxBin: ['rx bin', 'bin', 'pharmacy bin'],
    rxPcn: ['rx pcn', 'pcn', 'processor control number'],
    insurerName: ['insurer', 'carrier', 'insurance company', 'payer'],
  };

  for (const [field, keywords] of Object.entries(fieldMappings)) {
    for (const [key, value] of Object.entries(keyValuePairs)) {
      const keyLower = key.toLowerCase();
      if (keywords.some(kw => keyLower.includes(kw))) {
        insuranceFields[field] = { value: value.value, confidence: value.confidence };
        break;
      }
    }
  }

  // Also extract full text for additional parsing
  const rawText = extractRawText(response.Blocks || []);

  return {
    documentType: 'insurance_card',
    confidence: calculateOverallConfidence(insuranceFields),
    fields: insuranceFields,
    rawText,
  };
}

/**
 * Analyze ID card
 */
async function analyzeIdCard(data: {
  patientId: string;
  s3Key: string;
}): Promise<ExtractedData> {
  const { s3Key } = data;

  const command = new AnalyzeIDCommand({
    DocumentPages: [{
      S3Object: {
        Bucket: DOCUMENTS_BUCKET,
        Name: s3Key,
      },
    }],
  });

  const response = await textractClient.send(command);

  const idFields: Record<string, { value: string; confidence: number }> = {};

  // Extract ID document fields
  for (const doc of response.IdentityDocuments || []) {
    for (const field of doc.IdentityDocumentFields || []) {
      const fieldType = field.Type?.Text;
      const fieldValue = field.ValueDetection?.Text;
      const confidence = field.ValueDetection?.Confidence || 0;

      if (fieldType && fieldValue) {
        idFields[normalizeFieldName(fieldType)] = {
          value: fieldValue,
          confidence: confidence / 100,
        };
      }
    }
  }

  return {
    documentType: 'id_card',
    confidence: calculateOverallConfidence(idFields),
    fields: idFields,
  };
}

/**
 * Analyze form document
 */
async function analyzeForm(s3Key: string): Promise<ExtractedData> {
  const command = new AnalyzeDocumentCommand({
    Document: {
      S3Object: {
        Bucket: DOCUMENTS_BUCKET,
        Name: s3Key,
      },
    },
    FeatureTypes: ['FORMS', 'TABLES', 'SIGNATURES'],
  });

  const response = await textractClient.send(command);

  const keyValuePairs = extractKeyValuePairs(response.Blocks || []);
  const rawText = extractRawText(response.Blocks || []);

  const fields: Record<string, { value: string; confidence: number }> = {};
  for (const [key, value] of Object.entries(keyValuePairs)) {
    fields[normalizeFieldName(key)] = value;
  }

  return {
    documentType: 'form',
    confidence: calculateOverallConfidence(fields),
    fields,
    rawText,
  };
}

/**
 * Get document status
 */
async function getDocumentStatus(documentId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: DOCUMENT_TABLE,
    Key: { documentId },
  }));

  return result.Item || { error: 'Document not found' };
}

/**
 * Get patient documents
 */
async function getPatientDocuments(patientId: string): Promise<any> {
  // Query using GSI
  const result = await docClient.send(new GetCommand({
    TableName: DOCUMENT_TABLE,
    Key: { patientId },
  }));

  return {
    patientId,
    documents: result.Item ? [result.Item] : [],
  };
}

// Helper functions
function extractKeyValuePairs(blocks: any[]): Record<string, { value: string; confidence: number }> {
  const pairs: Record<string, { value: string; confidence: number }> = {};

  const keyBlocks = blocks.filter(b => b.BlockType === 'KEY_VALUE_SET' && b.EntityTypes?.includes('KEY'));
  const valueMap = new Map<string, any>();

  blocks.filter(b => b.BlockType === 'KEY_VALUE_SET' && b.EntityTypes?.includes('VALUE'))
    .forEach(b => valueMap.set(b.Id, b));

  for (const keyBlock of keyBlocks) {
    const keyText = getBlockText(keyBlock, blocks);
    const valueBlockId = keyBlock.Relationships?.find((r: any) => r.Type === 'VALUE')?.Ids?.[0];

    if (valueBlockId && valueMap.has(valueBlockId)) {
      const valueBlock = valueMap.get(valueBlockId);
      const valueText = getBlockText(valueBlock, blocks);

      if (keyText && valueText) {
        pairs[keyText] = {
          value: valueText,
          confidence: (keyBlock.Confidence + valueBlock.Confidence) / 200,
        };
      }
    }
  }

  return pairs;
}

function getBlockText(block: any, allBlocks: any[]): string {
  const childIds = block.Relationships?.find((r: any) => r.Type === 'CHILD')?.Ids || [];
  const childBlocks = allBlocks.filter(b => childIds.includes(b.Id) && b.BlockType === 'WORD');
  return childBlocks.map(b => b.Text).join(' ');
}

function extractRawText(blocks: any[]): string {
  return blocks
    .filter(b => b.BlockType === 'LINE')
    .map(b => b.Text)
    .join('\n');
}

function normalizeFieldName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function calculateOverallConfidence(fields: Record<string, { value: string; confidence: number }>): number {
  const values = Object.values(fields);
  if (values.length === 0) return 0;
  return values.reduce((sum, f) => sum + f.confidence, 0) / values.length;
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
      Source: 'medcx.documents',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
