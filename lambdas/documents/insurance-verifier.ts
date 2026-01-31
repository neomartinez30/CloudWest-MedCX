import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { v4 as uuidv4 } from 'uuid';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});
const eventBridge = new EventBridgeClient({});
const secretsManager = new SecretsManagerClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const VERIFICATION_TABLE = process.env.VERIFICATION_TABLE!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const ELIGIBILITY_API_SECRET_ARN = process.env.ELIGIBILITY_API_SECRET_ARN!;

interface InsuranceData {
  memberId?: { value: string; confidence: number };
  groupNumber?: { value: string; confidence: number };
  planName?: { value: string; confidence: number };
  memberName?: { value: string; confidence: number };
  effectiveDate?: { value: string; confidence: number };
  insurerName?: { value: string; confidence: number };
  copay?: { value: string; confidence: number };
  rxBin?: { value: string; confidence: number };
  rxPcn?: { value: string; confidence: number };
}

interface VerificationResult {
  verified: boolean;
  status: 'active' | 'inactive' | 'pending' | 'error';
  eligibilityData?: {
    effectiveDate?: string;
    terminationDate?: string;
    planType?: string;
    copay?: number;
    deductible?: number;
    deductibleMet?: number;
    outOfPocketMax?: number;
    outOfPocketMet?: number;
  };
  errors?: string[];
}

/**
 * Insurance Verifier Lambda
 *
 * Verifies patient insurance eligibility:
 * - Validates extracted insurance card data
 * - Checks eligibility with payers
 * - Updates patient records with verified info
 * - Sends confirmation to patients
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Insurance Verifier Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...data } = event;

    switch (action) {
      case 'verifyInsurance':
        return verifyInsurance(data);

      case 'checkEligibility':
        return checkEligibility(data);

      case 'getVerificationStatus':
        return getVerificationStatus(data.verificationId);

      case 'getPatientInsurance':
        return getPatientInsurance(data.patientId);

      case 'updateInsurance':
        return updatePatientInsurance(data);

      case 'getPayerList':
        return getPayerList();

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in insurance verifier:', error);
    return {
      error: 'Verification failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Verify insurance from extracted data
 */
async function verifyInsurance(data: {
  patientId: string;
  insuranceData: InsuranceData;
}): Promise<any> {
  const { patientId, insuranceData } = data;
  const verificationId = uuidv4();
  const now = new Date().toISOString();

  // Validate required fields
  const requiredFields = ['memberId', 'groupNumber'];
  const missingFields = requiredFields.filter(f => !insuranceData[f as keyof InsuranceData]?.value);

  if (missingFields.length > 0) {
    return {
      success: false,
      verificationId,
      status: 'incomplete',
      missingFields,
      message: 'Missing required insurance information',
    };
  }

  // Create verification record
  await docClient.send(new PutCommand({
    TableName: VERIFICATION_TABLE,
    Item: {
      verificationId,
      patientId,
      type: 'insurance',
      status: 'pending',
      inputData: insuranceData,
      createdAt: now,
      updatedAt: now,
    },
  }));

  // Check eligibility with payer
  const eligibilityResult = await checkEligibility({
    memberId: insuranceData.memberId?.value,
    groupNumber: insuranceData.groupNumber?.value,
    memberName: insuranceData.memberName?.value,
    insurerName: insuranceData.insurerName?.value,
  });

  // Update verification record
  await docClient.send(new UpdateCommand({
    TableName: VERIFICATION_TABLE,
    Key: { verificationId },
    UpdateExpression: 'SET #status = :status, eligibilityResult = :result, updatedAt = :updated',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': eligibilityResult.verified ? 'verified' : 'failed',
      ':result': eligibilityResult,
      ':updated': new Date().toISOString(),
    },
  }));

  // Update patient record if verified
  if (eligibilityResult.verified) {
    await updatePatientInsurance({
      patientId,
      insurance: {
        memberId: insuranceData.memberId?.value,
        groupNumber: insuranceData.groupNumber?.value,
        planName: insuranceData.planName?.value,
        insurerName: insuranceData.insurerName?.value,
        effectiveDate: insuranceData.effectiveDate?.value,
        verified: true,
        verifiedAt: now,
        eligibility: eligibilityResult.eligibilityData,
      },
    });

    // Notify patient
    await notifyPatient(patientId, 'insurance_verified', {
      insurerName: insuranceData.insurerName?.value,
      memberId: insuranceData.memberId?.value,
    });
  } else {
    // Notify patient of issue
    await notifyPatient(patientId, 'insurance_issue', {
      errors: eligibilityResult.errors,
    });
  }

  // Emit event
  await emitEvent('InsuranceVerified', {
    verificationId,
    patientId,
    verified: eligibilityResult.verified,
    timestamp: now,
  });

  return {
    success: eligibilityResult.verified,
    verificationId,
    status: eligibilityResult.status,
    eligibilityData: eligibilityResult.eligibilityData,
    errors: eligibilityResult.errors,
  };
}

/**
 * Check eligibility with payer
 */
async function checkEligibility(data: {
  memberId?: string;
  groupNumber?: string;
  memberName?: string;
  insurerName?: string;
  dateOfBirth?: string;
}): Promise<VerificationResult> {
  const { memberId, groupNumber, memberName, insurerName } = data;

  // In production, this would call actual payer APIs
  // For now, simulate eligibility check

  try {
    // Simulated payer lookup
    const payerCode = getPayerCode(insurerName || '');

    if (!payerCode) {
      return {
        verified: false,
        status: 'error',
        errors: ['Unknown insurance payer'],
      };
    }

    // Simulate eligibility response
    // In production, would use actual EDI 270/271 transactions
    const isActive = memberId && groupNumber && memberId.length >= 6;

    if (isActive) {
      return {
        verified: true,
        status: 'active',
        eligibilityData: {
          effectiveDate: '2024-01-01',
          terminationDate: '2024-12-31',
          planType: 'PPO',
          copay: 25,
          deductible: 500,
          deductibleMet: 350,
          outOfPocketMax: 3000,
          outOfPocketMet: 850,
        },
      };
    } else {
      return {
        verified: false,
        status: 'inactive',
        errors: ['Member not found or inactive'],
      };
    }
  } catch (error) {
    return {
      verified: false,
      status: 'error',
      errors: [error instanceof Error ? error.message : 'Eligibility check failed'],
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
 * Get patient insurance info
 */
async function getPatientInsurance(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));

  if (!result.Item?.insurance) {
    return { patientId, hasInsurance: false };
  }

  return {
    patientId,
    hasInsurance: true,
    insurance: result.Item.insurance,
    verified: result.Item.insurance.verified || false,
    verifiedAt: result.Item.insurance.verifiedAt,
  };
}

/**
 * Update patient insurance
 */
async function updatePatientInsurance(data: {
  patientId: string;
  insurance: any;
}): Promise<any> {
  const { patientId, insurance } = data;
  const now = new Date().toISOString();

  await docClient.send(new UpdateCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
    UpdateExpression: 'SET insurance = :insurance, updatedAt = :updated',
    ExpressionAttributeValues: {
      ':insurance': insurance,
      ':updated': now,
    },
  }));

  await emitEvent('PatientInsuranceUpdated', {
    patientId,
    verified: insurance.verified,
    timestamp: now,
  });

  return {
    success: true,
    patientId,
    insurance,
  };
}

/**
 * Get list of supported payers
 */
async function getPayerList(): Promise<any> {
  // In production, this would come from a database or external service
  return {
    payers: [
      { code: 'AETNA', name: 'Aetna', supported: true },
      { code: 'BCBS', name: 'Blue Cross Blue Shield', supported: true },
      { code: 'CIGNA', name: 'Cigna', supported: true },
      { code: 'UHC', name: 'UnitedHealthcare', supported: true },
      { code: 'HUMANA', name: 'Humana', supported: true },
      { code: 'KAISER', name: 'Kaiser Permanente', supported: true },
      { code: 'ANTHEM', name: 'Anthem', supported: true },
      { code: 'MEDICARE', name: 'Medicare', supported: true },
      { code: 'MEDICAID', name: 'Medicaid', supported: true },
    ],
  };
}

// Helper functions
function getPayerCode(insurerName: string): string | null {
  const payerMappings: Record<string, string> = {
    'aetna': 'AETNA',
    'blue cross': 'BCBS',
    'blue shield': 'BCBS',
    'bcbs': 'BCBS',
    'cigna': 'CIGNA',
    'united': 'UHC',
    'unitedhealthcare': 'UHC',
    'uhc': 'UHC',
    'humana': 'HUMANA',
    'kaiser': 'KAISER',
    'anthem': 'ANTHEM',
    'medicare': 'MEDICARE',
    'medicaid': 'MEDICAID',
  };

  const normalized = insurerName.toLowerCase();
  for (const [key, code] of Object.entries(payerMappings)) {
    if (normalized.includes(key)) {
      return code;
    }
  }

  return null;
}

async function notifyPatient(patientId: string, notificationType: string, data: any): Promise<void> {
  let message: string;

  switch (notificationType) {
    case 'insurance_verified':
      message = `Great news! Your ${data.insurerName || 'insurance'} coverage has been verified. Member ID: ${data.memberId}`;
      break;

    case 'insurance_issue':
      message = `We had trouble verifying your insurance. Please contact us or upload a new photo of your insurance card.`;
      break;

    default:
      message = 'Insurance verification update.';
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
      Source: 'medcx.insurance',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
