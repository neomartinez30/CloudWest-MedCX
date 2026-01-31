import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminGetUserCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { randomInt } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const cognitoClient = new CognitoIdentityProviderClient({});
const smsClient = new PinpointSMSVoiceV2Client({});

const OTP_TABLE = process.env.OTP_TABLE!;
const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;
const ORIGINATION_IDENTITY = process.env.ORIGINATION_IDENTITY!;

const OTP_EXPIRY_MINUTES = 5;
const MAX_OTP_ATTEMPTS = 3;

interface OTPRecord {
  phoneNumber: string;
  otp: string;
  patientId?: string;
  attempts: number;
  createdAt: string;
  expiresAt: number;
}

/**
 * OTP Authentication Handler
 *
 * Handles one-time PIN generation and verification for phone-based authentication:
 * - Generate and send OTP via SMS
 * - Verify OTP entered by caller
 * - Check if phone number exists in system
 * - Integrate with Cognito for user management
 */
export const handler = async (event: any): Promise<any> => {
  console.log('OTP Handler Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...data } = event;

    switch (action) {
      case 'checkPhoneNumber':
        return checkPhoneNumber(data.phoneNumber);

      case 'generateOTP':
        return generateAndSendOTP(data.phoneNumber, data.patientId);

      case 'verifyOTP':
        return verifyOTP(data.phoneNumber, data.otp);

      case 'resendOTP':
        return resendOTP(data.phoneNumber);

      case 'enrollUser':
        return enrollNewUser(data);

      case 'getAuthStatus':
        return getAuthStatus(data.phoneNumber);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in OTP handler:', error);
    return {
      success: false,
      error: 'Authentication failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Check if phone number exists in the system
 */
async function checkPhoneNumber(phoneNumber: string): Promise<any> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  // Query patient table by phone number GSI
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { phoneNumber: normalizedPhone },
    ProjectionExpression: 'patientId, firstName, lastName, phoneNumber',
  }));

  // If not found by direct key, try querying the phone-index GSI
  if (!result.Item) {
    const { DynamoDBDocumentClient, QueryCommand } = await import('@aws-sdk/lib-dynamodb');

    const queryResult = await docClient.send(new QueryCommand({
      TableName: PATIENT_TABLE,
      IndexName: 'phone-index',
      KeyConditionExpression: 'phoneNumber = :phone',
      FilterExpression: 'recordType = :profile',
      ExpressionAttributeValues: {
        ':phone': normalizedPhone,
        ':profile': 'PROFILE',
      },
      Limit: 1,
    }));

    if (queryResult.Items && queryResult.Items.length > 0) {
      const patient = queryResult.Items[0];
      return {
        found: true,
        patientId: patient.patientId,
        firstName: patient.firstName,
        maskedPhone: maskPhoneNumber(normalizedPhone),
      };
    }
  }

  if (result.Item) {
    return {
      found: true,
      patientId: result.Item.patientId,
      firstName: result.Item.firstName,
      maskedPhone: maskPhoneNumber(normalizedPhone),
    };
  }

  return {
    found: false,
    message: 'Phone number not registered',
  };
}

/**
 * Generate and send OTP via SMS
 */
async function generateAndSendOTP(phoneNumber: string, patientId?: string): Promise<any> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  const otp = generateOTP();
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + (OTP_EXPIRY_MINUTES * 60);

  // Store OTP in DynamoDB with TTL
  await docClient.send(new PutCommand({
    TableName: OTP_TABLE,
    Item: {
      phoneNumber: normalizedPhone,
      otp,
      patientId,
      attempts: 0,
      createdAt: now.toISOString(),
      expiresAt,
    },
  }));

  // Send OTP via SMS
  try {
    await smsClient.send(new SendTextMessageCommand({
      DestinationPhoneNumber: normalizedPhone,
      OriginationIdentity: ORIGINATION_IDENTITY,
      MessageBody: `Your CloudWest Medical verification code is: ${otp}. This code expires in ${OTP_EXPIRY_MINUTES} minutes. Do not share this code with anyone.`,
      MessageType: 'TRANSACTIONAL',
    }));

    return {
      success: true,
      message: 'Verification code sent',
      expiresInMinutes: OTP_EXPIRY_MINUTES,
      maskedPhone: maskPhoneNumber(normalizedPhone),
    };
  } catch (smsError) {
    console.error('Failed to send OTP SMS:', smsError);
    return {
      success: false,
      error: 'Failed to send verification code',
    };
  }
}

/**
 * Verify OTP entered by caller
 */
async function verifyOTP(phoneNumber: string, enteredOTP: string): Promise<any> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  // Get stored OTP
  const result = await docClient.send(new GetCommand({
    TableName: OTP_TABLE,
    Key: { phoneNumber: normalizedPhone },
  }));

  if (!result.Item) {
    return {
      verified: false,
      error: 'NO_OTP_FOUND',
      message: 'No verification code found. Please request a new code.',
    };
  }

  const otpRecord = result.Item as OTPRecord;

  // Check if expired
  const now = Math.floor(Date.now() / 1000);
  if (now > otpRecord.expiresAt) {
    await deleteOTP(normalizedPhone);
    return {
      verified: false,
      error: 'OTP_EXPIRED',
      message: 'Verification code has expired. Please request a new code.',
    };
  }

  // Check attempts
  if (otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
    await deleteOTP(normalizedPhone);
    return {
      verified: false,
      error: 'MAX_ATTEMPTS_EXCEEDED',
      message: 'Too many failed attempts. Please request a new code.',
    };
  }

  // Verify OTP
  if (enteredOTP === otpRecord.otp) {
    // Success - delete OTP and return patient info
    await deleteOTP(normalizedPhone);

    return {
      verified: true,
      patientId: otpRecord.patientId,
      message: 'Verification successful',
    };
  }

  // Increment attempts
  await docClient.send(new UpdateCommand({
    TableName: OTP_TABLE,
    Key: { phoneNumber: normalizedPhone },
    UpdateExpression: 'SET attempts = attempts + :inc',
    ExpressionAttributeValues: { ':inc': 1 },
  }));

  const remainingAttempts = MAX_OTP_ATTEMPTS - otpRecord.attempts - 1;

  return {
    verified: false,
    error: 'INVALID_OTP',
    message: `Invalid code. ${remainingAttempts} attempt${remainingAttempts !== 1 ? 's' : ''} remaining.`,
    remainingAttempts,
  };
}

/**
 * Resend OTP
 */
async function resendOTP(phoneNumber: string): Promise<any> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  // Get existing OTP record to preserve patientId
  const existing = await docClient.send(new GetCommand({
    TableName: OTP_TABLE,
    Key: { phoneNumber: normalizedPhone },
  }));

  const patientId = existing.Item?.patientId;

  // Generate new OTP
  return generateAndSendOTP(normalizedPhone, patientId);
}

/**
 * Enroll new user in Cognito and patient table
 */
async function enrollNewUser(data: {
  phoneNumber: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  email?: string;
}): Promise<any> {
  const { phoneNumber, firstName, lastName, dateOfBirth, email } = data;
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  const patientId = generatePatientId();
  const now = new Date().toISOString();

  try {
    // Create user in Cognito
    await cognitoClient.send(new AdminCreateUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: normalizedPhone,
      UserAttributes: [
        { Name: 'phone_number', Value: normalizedPhone },
        { Name: 'phone_number_verified', Value: 'true' },
        { Name: 'given_name', Value: firstName },
        { Name: 'family_name', Value: lastName },
        { Name: 'custom:patientId', Value: patientId },
        ...(email ? [{ Name: 'email', Value: email }] : []),
      ],
      MessageAction: 'SUPPRESS', // Don't send welcome email, we'll handle via our flow
    }));

    // Create patient profile in DynamoDB
    await docClient.send(new PutCommand({
      TableName: PATIENT_TABLE,
      Item: {
        patientId,
        recordType: 'PROFILE',
        phoneNumber: normalizedPhone,
        firstName,
        lastName,
        dateOfBirth,
        email,
        preferredChannel: 'voice',
        status: 'active',
        consentStatus: {
          hipaaConsent: false,
          marketingConsent: false,
          smsConsent: true,
          hipaaConsentDate: null,
          marketingConsentDate: null,
          smsConsentDate: now,
        },
        createdAt: now,
        updatedAt: now,
      },
      ConditionExpression: 'attribute_not_exists(patientId)',
    }));

    return {
      success: true,
      patientId,
      message: 'Enrollment successful',
      firstName,
    };
  } catch (error: any) {
    console.error('Enrollment error:', error);

    if (error.name === 'UsernameExistsException') {
      return {
        success: false,
        error: 'USER_EXISTS',
        message: 'This phone number is already registered.',
      };
    }

    return {
      success: false,
      error: 'ENROLLMENT_FAILED',
      message: 'Failed to complete enrollment. Please try again.',
    };
  }
}

/**
 * Get authentication status for a phone number
 */
async function getAuthStatus(phoneNumber: string): Promise<any> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  // Check for active OTP
  const otpResult = await docClient.send(new GetCommand({
    TableName: OTP_TABLE,
    Key: { phoneNumber: normalizedPhone },
  }));

  if (otpResult.Item) {
    const now = Math.floor(Date.now() / 1000);
    const otpRecord = otpResult.Item as OTPRecord;

    return {
      hasActiveOTP: now <= otpRecord.expiresAt,
      remainingAttempts: MAX_OTP_ATTEMPTS - otpRecord.attempts,
      expiresIn: Math.max(0, otpRecord.expiresAt - now),
    };
  }

  return {
    hasActiveOTP: false,
  };
}

// Helper functions

function normalizePhoneNumber(phone: string): string {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');

  // Add +1 for US numbers if not present
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  if (!phone.startsWith('+')) {
    return `+${digits}`;
  }
  return phone;
}

function maskPhoneNumber(phone: string): string {
  // Show only last 4 digits: +1******1234
  if (phone.length >= 4) {
    const last4 = phone.slice(-4);
    const prefix = phone.slice(0, 2);
    return `${prefix}******${last4}`;
  }
  return '******';
}

function generateOTP(): string {
  // Generate 6-digit OTP
  return randomInt(100000, 999999).toString();
}

function generatePatientId(): string {
  // Generate unique patient ID: PT-XXXXXXXX
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'PT-';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(randomInt(0, chars.length));
  }
  return id;
}

async function deleteOTP(phoneNumber: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: OTP_TABLE,
    Key: { phoneNumber },
  }));
}
