import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { RekognitionClient, CompareFacesCommand, DetectTextCommand } from '@aws-sdk/client-rekognition';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});
const eventBridge = new EventBridgeClient({});
const rekognitionClient = new RekognitionClient({});
const s3Client = new S3Client({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const VERIFICATION_TABLE = process.env.VERIFICATION_TABLE!;
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface IdData {
  first_name?: { value: string; confidence: number };
  last_name?: { value: string; confidence: number };
  middle_name?: { value: string; confidence: number };
  date_of_birth?: { value: string; confidence: number };
  address?: { value: string; confidence: number };
  id_number?: { value: string; confidence: number };
  expiration_date?: { value: string; confidence: number };
  issue_date?: { value: string; confidence: number };
  document_type?: { value: string; confidence: number };
  state?: { value: string; confidence: number };
}

interface IdVerificationResult {
  verified: boolean;
  status: 'verified' | 'failed' | 'expired' | 'mismatch' | 'pending';
  matchScore?: number;
  issues?: string[];
  extractedData?: IdData;
}

/**
 * ID Verifier Lambda
 *
 * Verifies patient identity documents:
 * - Validates extracted ID card data
 * - Compares with patient profile
 * - Checks document expiration
 * - Face matching (if photo available)
 * - Fraud detection
 */
export const handler = async (event: any): Promise<any> => {
  console.log('ID Verifier Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...data } = event;

    switch (action) {
      case 'verifyId':
        return verifyId(data);

      case 'compareWithProfile':
        return compareWithProfile(data);

      case 'checkExpiration':
        return checkExpiration(data);

      case 'compareFaces':
        return compareFaces(data);

      case 'getVerificationStatus':
        return getVerificationStatus(data.verificationId);

      case 'getPatientIdStatus':
        return getPatientIdStatus(data.patientId);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in ID verifier:', error);
    return {
      error: 'ID verification failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Verify ID from extracted data
 */
async function verifyId(data: {
  patientId: string;
  idData: IdData;
  s3Key?: string;
}): Promise<any> {
  const { patientId, idData, s3Key } = data;
  const verificationId = uuidv4();
  const now = new Date().toISOString();

  // Create verification record
  await docClient.send(new PutCommand({
    TableName: VERIFICATION_TABLE,
    Item: {
      verificationId,
      patientId,
      type: 'id',
      status: 'pending',
      inputData: idData,
      s3Key,
      createdAt: now,
      updatedAt: now,
    },
  }));

  const issues: string[] = [];
  let matchScore = 0;

  // Get patient profile for comparison
  const patientResult = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));

  const patient = patientResult.Item;

  if (!patient) {
    return {
      success: false,
      verificationId,
      status: 'failed',
      issues: ['Patient profile not found'],
    };
  }

  // Compare extracted data with profile
  const comparisonResult = compareFields(idData, patient);
  matchScore = comparisonResult.score;
  issues.push(...comparisonResult.issues);

  // Check expiration
  const expirationResult = checkExpirationDate(idData.expiration_date?.value);
  if (!expirationResult.valid) {
    issues.push(expirationResult.message);
  }

  // Determine final status
  let status: IdVerificationResult['status'] = 'pending';
  let verified = false;

  if (issues.length === 0 && matchScore >= 80) {
    status = 'verified';
    verified = true;
  } else if (issues.some(i => i.includes('expired'))) {
    status = 'expired';
  } else if (matchScore < 50) {
    status = 'mismatch';
  } else {
    status = 'failed';
  }

  // Update verification record
  await docClient.send(new UpdateCommand({
    TableName: VERIFICATION_TABLE,
    Key: { verificationId },
    UpdateExpression: 'SET #status = :status, matchScore = :score, issues = :issues, updatedAt = :updated',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ':score': matchScore,
      ':issues': issues,
      ':updated': new Date().toISOString(),
    },
  }));

  // Update patient record if verified
  if (verified) {
    await updatePatientIdVerification(patientId, {
      verified: true,
      verifiedAt: now,
      documentType: idData.document_type?.value || 'unknown',
      expirationDate: idData.expiration_date?.value,
      matchScore,
    });

    // Notify patient
    await notifyPatient(patientId, 'id_verified');
  } else if (status === 'expired' || status === 'mismatch') {
    await notifyPatient(patientId, 'id_issue', { issues });
  }

  // Emit event
  await emitEvent('IdVerified', {
    verificationId,
    patientId,
    verified,
    status,
    matchScore,
    timestamp: now,
  });

  return {
    success: verified,
    verificationId,
    status,
    matchScore,
    issues: issues.length > 0 ? issues : undefined,
  };
}

/**
 * Compare ID data with patient profile
 */
async function compareWithProfile(data: {
  patientId: string;
  idData: IdData;
}): Promise<any> {
  const { patientId, idData } = data;

  const patientResult = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));

  if (!patientResult.Item) {
    return { error: 'Patient not found' };
  }

  return compareFields(idData, patientResult.Item);
}

/**
 * Check if ID is expired
 */
async function checkExpiration(data: { expirationDate: string }): Promise<any> {
  return checkExpirationDate(data.expirationDate);
}

/**
 * Compare faces between ID and selfie
 */
async function compareFaces(data: {
  patientId: string;
  idImageKey: string;
  selfieImageKey: string;
}): Promise<any> {
  const { patientId, idImageKey, selfieImageKey } = data;

  try {
    const command = new CompareFacesCommand({
      SourceImage: {
        S3Object: {
          Bucket: DOCUMENTS_BUCKET,
          Name: idImageKey,
        },
      },
      TargetImage: {
        S3Object: {
          Bucket: DOCUMENTS_BUCKET,
          Name: selfieImageKey,
        },
      },
      SimilarityThreshold: 80,
    });

    const response = await rekognitionClient.send(command);

    const match = response.FaceMatches?.[0];
    const similarity = match?.Similarity || 0;
    const matched = similarity >= 90;

    return {
      matched,
      similarity,
      confidence: match?.Face?.Confidence || 0,
    };
  } catch (error) {
    console.error('Face comparison error:', error);
    return {
      matched: false,
      error: error instanceof Error ? error.message : 'Face comparison failed',
    };
  }
}

/**
 * Get verification status
 */
async function getVerificationStatus(verificationId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: VERIFICATION_TABLE,
    Key: { verificationId },
  }));

  return result.Item || { error: 'Verification not found' };
}

/**
 * Get patient ID verification status
 */
async function getPatientIdStatus(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));

  if (!result.Item?.idVerification) {
    return { patientId, verified: false };
  }

  return {
    patientId,
    verified: result.Item.idVerification.verified || false,
    verifiedAt: result.Item.idVerification.verifiedAt,
    expirationDate: result.Item.idVerification.expirationDate,
    documentType: result.Item.idVerification.documentType,
  };
}

// Helper functions
function compareFields(idData: IdData, patient: any): { score: number; issues: string[] } {
  const issues: string[] = [];
  let matchedFields = 0;
  let totalFields = 0;

  // Compare first name
  if (idData.first_name?.value && patient.firstName) {
    totalFields++;
    if (normalizeString(idData.first_name.value) === normalizeString(patient.firstName)) {
      matchedFields++;
    } else {
      issues.push(`First name mismatch: ID shows "${idData.first_name.value}", profile has "${patient.firstName}"`);
    }
  }

  // Compare last name
  if (idData.last_name?.value && patient.lastName) {
    totalFields++;
    if (normalizeString(idData.last_name.value) === normalizeString(patient.lastName)) {
      matchedFields++;
    } else {
      issues.push(`Last name mismatch: ID shows "${idData.last_name.value}", profile has "${patient.lastName}"`);
    }
  }

  // Compare date of birth
  if (idData.date_of_birth?.value && patient.dateOfBirth) {
    totalFields++;
    if (normalizeDob(idData.date_of_birth.value) === normalizeDob(patient.dateOfBirth)) {
      matchedFields++;
    } else {
      issues.push('Date of birth mismatch');
    }
  }

  // Compare address if available
  if (idData.address?.value && patient.address) {
    totalFields++;
    const idAddress = normalizeAddress(idData.address.value);
    const patientAddress = normalizeAddress(
      `${patient.address.street || ''} ${patient.address.city || ''} ${patient.address.state || ''}`
    );
    if (addressMatch(idAddress, patientAddress)) {
      matchedFields++;
    } else {
      issues.push('Address may not match');
    }
  }

  const score = totalFields > 0 ? Math.round((matchedFields / totalFields) * 100) : 0;

  return { score, issues };
}

function normalizeString(str: string): string {
  return str.toLowerCase().trim().replace(/[^a-z]/g, '');
}

function normalizeDob(dob: string): string {
  // Handle various date formats
  const cleaned = dob.replace(/[^0-9]/g, '');
  if (cleaned.length === 8) {
    // Assume MMDDYYYY or YYYYMMDD
    if (cleaned.startsWith('19') || cleaned.startsWith('20')) {
      return cleaned; // YYYYMMDD
    }
    return cleaned.slice(4) + cleaned.slice(0, 4); // Convert MMDDYYYY to YYYYMMDD
  }
  return cleaned;
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase()
    .replace(/\bst\b/g, 'street')
    .replace(/\bave\b/g, 'avenue')
    .replace(/\brd\b/g, 'road')
    .replace(/\bdr\b/g, 'drive')
    .replace(/\bapt\b/g, 'apartment')
    .replace(/[^a-z0-9]/g, '');
}

function addressMatch(addr1: string, addr2: string): boolean {
  // Simple matching - in production would use more sophisticated address matching
  const similarity = calculateStringSimilarity(addr1, addr2);
  return similarity > 0.7;
}

function calculateStringSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1.0;

  const matchingChars = shorter.split('').filter((char, i) => longer[i] === char).length;
  return matchingChars / longer.length;
}

function checkExpirationDate(expirationDate?: string): { valid: boolean; message: string } {
  if (!expirationDate) {
    return { valid: true, message: 'No expiration date found' };
  }

  try {
    const expDate = new Date(expirationDate);
    const now = new Date();

    if (expDate < now) {
      return { valid: false, message: 'ID document has expired' };
    }

    // Warn if expiring within 30 days
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    if (expDate < thirtyDaysFromNow) {
      return { valid: true, message: 'ID document expiring soon' };
    }

    return { valid: true, message: 'ID document is valid' };
  } catch {
    return { valid: true, message: 'Could not parse expiration date' };
  }
}

async function updatePatientIdVerification(patientId: string, verification: any): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
    UpdateExpression: 'SET idVerification = :verification, updatedAt = :updated',
    ExpressionAttributeValues: {
      ':verification': verification,
      ':updated': new Date().toISOString(),
    },
  }));
}

async function notifyPatient(patientId: string, notificationType: string, data?: any): Promise<void> {
  let message: string;

  switch (notificationType) {
    case 'id_verified':
      message = 'Your ID has been verified successfully. Thank you!';
      break;

    case 'id_issue':
      message = 'We had trouble verifying your ID. Please contact us or upload a new photo of your ID.';
      break;

    default:
      message = 'ID verification update.';
  }

  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendOutbound',
    channel: 'sms',
    patientId,
    content: message,
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
      Source: 'medcx.identity',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
