import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import Stripe from 'stripe';
import { v4 as uuidv4 } from 'uuid';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});
const secretsManager = new SecretsManagerClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const STRIPE_SECRET_NAME = process.env.STRIPE_SECRET_NAME!;
const PAYMENT_SUCCESS_URL = process.env.PAYMENT_SUCCESS_URL || 'https://cloudwestmedical.com/payment/success';
const PAYMENT_CANCEL_URL = process.env.PAYMENT_CANCEL_URL || 'https://cloudwestmedical.com/payment/cancel';

interface PaymentRequest {
  action: 'createPaymentIntent' | 'createPaymentLink' | 'getPaymentStatus' | 'processWebhook' | 'listPayments';
  patientId?: string;
  amount?: number;
  description?: string;
  appointmentId?: string;
  paymentType?: 'copay' | 'balance' | 'deposit' | 'other';
  paymentId?: string;
  webhookPayload?: any;
  webhookSignature?: string;
}

interface Payment {
  paymentId: string;
  patientId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
  paymentType: string;
  description?: string;
  appointmentId?: string;
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
  paymentLink?: string;
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
}

let stripeClient: Stripe | null = null;

/**
 * Payment Handler Lambda
 *
 * Handles all payment operations for the medical contact center:
 * - Create payment intents for copays and balances
 * - Generate payment links for SMS
 * - Process Stripe webhooks
 * - Track payment status
 */
export const handler = async (event: PaymentRequest | any): Promise<any> => {
  console.log('Payment Handler Event:', JSON.stringify(event, null, 2));

  try {
    // Handle API Gateway requests
    if (event.httpMethod) {
      return handleApiRequest(event);
    }

    // Handle direct invocations
    const request = event as PaymentRequest;

    switch (request.action) {
      case 'createPaymentIntent':
        return createPaymentIntent(request);

      case 'createPaymentLink':
        return createPaymentLink(request);

      case 'getPaymentStatus':
        return getPaymentStatus(request.paymentId!);

      case 'processWebhook':
        return processWebhook(request.webhookPayload, request.webhookSignature!);

      case 'listPayments':
        return listPatientPayments(request.patientId!);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in payment handler:', error);
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
  const { httpMethod, path, body, pathParameters, headers } = event;
  const paymentId = pathParameters?.paymentId;
  const patientId = pathParameters?.patientId;
  const data = body ? JSON.parse(body) : {};

  // Handle webhook endpoint
  if (path.includes('/webhook')) {
    return formatResponse(
      200,
      await processWebhook(body, headers['stripe-signature'] || headers['Stripe-Signature'])
    );
  }

  switch (httpMethod) {
    case 'GET':
      if (paymentId) {
        return formatResponse(200, await getPaymentStatus(paymentId));
      }
      if (patientId) {
        return formatResponse(200, await listPatientPayments(patientId));
      }
      return formatResponse(400, { error: 'Payment ID or Patient ID required' });

    case 'POST':
      if (path.includes('/link')) {
        return formatResponse(200, await createPaymentLink(data));
      }
      return formatResponse(201, await createPaymentIntent(data));

    default:
      return formatResponse(405, { error: 'Method not allowed' });
  }
}

/**
 * Get Stripe client
 */
async function getStripe(): Promise<Stripe> {
  if (stripeClient) return stripeClient;

  const secret = await getSecret(STRIPE_SECRET_NAME);
  stripeClient = new Stripe(secret.secretKey, {
    apiVersion: '2023-10-16',
  });

  return stripeClient;
}

/**
 * Create a payment intent
 */
async function createPaymentIntent(request: PaymentRequest): Promise<any> {
  const { patientId, amount, description, appointmentId, paymentType = 'copay' } = request;

  if (!patientId || !amount) {
    return { error: 'patientId and amount are required' };
  }

  const stripe = await getStripe();
  const paymentId = uuidv4();
  const now = new Date().toISOString();

  // Get patient info
  const patient = await getPatient(patientId);
  if (!patient) {
    return { error: 'Patient not found' };
  }

  // Create Stripe payment intent
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // Convert to cents
    currency: 'usd',
    description: description || `${paymentType} payment for CloudWest Medical`,
    metadata: {
      patientId,
      paymentId,
      appointmentId: appointmentId || '',
      paymentType,
    },
    receipt_email: patient.email,
  });

  // Store payment record
  const payment: Payment = {
    paymentId,
    patientId,
    amount,
    currency: 'usd',
    status: 'pending',
    paymentType,
    description,
    appointmentId,
    stripePaymentIntentId: paymentIntent.id,
    createdAt: now,
    updatedAt: now,
  };

  await storePayment(payment);

  // Emit event
  await emitEvent('PaymentCreated', {
    paymentId,
    patientId,
    amount,
    paymentType,
    timestamp: now,
  });

  return {
    paymentId,
    clientSecret: paymentIntent.client_secret,
    amount,
    currency: 'usd',
    status: 'pending',
  };
}

/**
 * Create a payment link for SMS
 */
async function createPaymentLink(request: PaymentRequest): Promise<any> {
  const { patientId, amount, description, appointmentId, paymentType = 'copay' } = request;

  if (!patientId || !amount) {
    return { error: 'patientId and amount are required' };
  }

  const stripe = await getStripe();
  const paymentId = uuidv4();
  const now = new Date().toISOString();

  // Get patient info
  const patient = await getPatient(patientId);
  if (!patient) {
    return { error: 'Patient not found' };
  }

  // Create Stripe checkout session
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(amount * 100),
          product_data: {
            name: description || `${paymentType} Payment`,
            description: `CloudWest Medical - ${paymentType}`,
          },
        },
        quantity: 1,
      },
    ],
    customer_email: patient.email,
    metadata: {
      patientId,
      paymentId,
      appointmentId: appointmentId || '',
      paymentType,
    },
    success_url: `${PAYMENT_SUCCESS_URL}?payment_id=${paymentId}`,
    cancel_url: `${PAYMENT_CANCEL_URL}?payment_id=${paymentId}`,
    expires_at: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // 24 hours
  });

  // Store payment record
  const payment: Payment = {
    paymentId,
    patientId,
    amount,
    currency: 'usd',
    status: 'pending',
    paymentType,
    description,
    appointmentId,
    stripeCheckoutSessionId: session.id,
    paymentLink: session.url!,
    createdAt: now,
    updatedAt: now,
  };

  await storePayment(payment);

  // Emit event
  await emitEvent('PaymentLinkCreated', {
    paymentId,
    patientId,
    amount,
    paymentType,
    paymentLink: session.url,
    timestamp: now,
  });

  return {
    paymentId,
    paymentLink: session.url,
    amount,
    expiresAt: new Date(session.expires_at * 1000).toISOString(),
    // SMS-friendly short message
    smsMessage: `Your copay of $${amount.toFixed(2)} is ready. Pay securely: ${session.url}`,
  };
}

/**
 * Get payment status
 */
async function getPaymentStatus(paymentId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: PATIENT_TABLE,
    IndexName: 'externalId-index',
    KeyConditionExpression: 'externalId = :paymentId',
    ExpressionAttributeValues: {
      ':paymentId': `PAYMENT#${paymentId}`,
    },
    Limit: 1,
  }));

  if (!result.Items || result.Items.length === 0) {
    return { error: 'Payment not found' };
  }

  return result.Items[0];
}

/**
 * List patient payments
 */
async function listPatientPayments(patientId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: PATIENT_TABLE,
    KeyConditionExpression: 'patientId = :patientId AND begins_with(recordType, :prefix)',
    ExpressionAttributeValues: {
      ':patientId': patientId,
      ':prefix': 'PAYMENT#',
    },
    ScanIndexForward: false, // Most recent first
    Limit: 50,
  }));

  return {
    payments: result.Items || [],
    count: result.Items?.length || 0,
  };
}

/**
 * Process Stripe webhook
 */
async function processWebhook(payload: string, signature: string): Promise<any> {
  const stripe = await getStripe();
  const secret = await getSecret(STRIPE_SECRET_NAME);

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(payload, signature, secret.webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return { error: 'Webhook signature verification failed' };
  }

  console.log('Processing webhook event:', event.type);

  switch (event.type) {
    case 'payment_intent.succeeded':
      await handlePaymentSuccess(event.data.object as Stripe.PaymentIntent);
      break;

    case 'payment_intent.payment_failed':
      await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
      break;

    case 'checkout.session.completed':
      await handleCheckoutComplete(event.data.object as Stripe.Checkout.Session);
      break;

    case 'checkout.session.expired':
      await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
      break;

    default:
      console.log('Unhandled event type:', event.type);
  }

  return { received: true };
}

/**
 * Handle successful payment
 */
async function handlePaymentSuccess(paymentIntent: Stripe.PaymentIntent): Promise<void> {
  const { patientId, paymentId } = paymentIntent.metadata;
  const now = new Date().toISOString();

  // Update payment record
  await updatePaymentStatus(patientId, paymentId, 'completed', {
    paidAt: now,
    stripePaymentIntentId: paymentIntent.id,
  });

  // Update patient's outstanding balance
  await updatePatientBalance(patientId, -(paymentIntent.amount / 100));

  // Emit event
  await emitEvent('PaymentCompleted', {
    paymentId,
    patientId,
    amount: paymentIntent.amount / 100,
    timestamp: now,
  });
}

/**
 * Handle failed payment
 */
async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
  const { patientId, paymentId } = paymentIntent.metadata;
  const now = new Date().toISOString();

  await updatePaymentStatus(patientId, paymentId, 'failed', {
    failedAt: now,
    failureReason: paymentIntent.last_payment_error?.message,
  });

  await emitEvent('PaymentFailed', {
    paymentId,
    patientId,
    reason: paymentIntent.last_payment_error?.message,
    timestamp: now,
  });
}

/**
 * Handle completed checkout session
 */
async function handleCheckoutComplete(session: Stripe.Checkout.Session): Promise<void> {
  const { patientId, paymentId } = session.metadata || {};
  const now = new Date().toISOString();

  if (!patientId || !paymentId) {
    console.log('Missing metadata in checkout session');
    return;
  }

  await updatePaymentStatus(patientId, paymentId, 'completed', {
    paidAt: now,
    stripeCheckoutSessionId: session.id,
  });

  await updatePatientBalance(patientId, -(session.amount_total! / 100));

  await emitEvent('PaymentCompleted', {
    paymentId,
    patientId,
    amount: session.amount_total! / 100,
    source: 'checkout_link',
    timestamp: now,
  });
}

/**
 * Handle expired checkout session
 */
async function handleCheckoutExpired(session: Stripe.Checkout.Session): Promise<void> {
  const { patientId, paymentId } = session.metadata || {};

  if (!patientId || !paymentId) return;

  await updatePaymentStatus(patientId, paymentId, 'failed', {
    expiredAt: new Date().toISOString(),
    failureReason: 'Payment link expired',
  });
}

/**
 * Store payment record
 */
async function storePayment(payment: Payment): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: PATIENT_TABLE,
    Item: {
      patientId: payment.patientId,
      recordType: `PAYMENT#${payment.paymentId}`,
      externalId: `PAYMENT#${payment.paymentId}`,
      ...payment,
    },
  }));
}

/**
 * Update payment status
 */
async function updatePaymentStatus(
  patientId: string,
  paymentId: string,
  status: Payment['status'],
  additionalData: Record<string, any> = {}
): Promise<void> {
  const updateExpression = ['#status = :status', 'updatedAt = :now'];
  const expressionAttributeNames: Record<string, string> = { '#status': 'status' };
  const expressionAttributeValues: Record<string, any> = {
    ':status': status,
    ':now': new Date().toISOString(),
  };

  for (const [key, value] of Object.entries(additionalData)) {
    updateExpression.push(`${key} = :${key}`);
    expressionAttributeValues[`:${key}`] = value;
  }

  await docClient.send(new UpdateCommand({
    TableName: PATIENT_TABLE,
    Key: {
      patientId,
      recordType: `PAYMENT#${paymentId}`,
    },
    UpdateExpression: `SET ${updateExpression.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
  }));
}

/**
 * Update patient's outstanding balance
 */
async function updatePatientBalance(patientId: string, balanceChange: number): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: PATIENT_TABLE,
    Key: {
      patientId,
      recordType: 'PROFILE',
    },
    UpdateExpression: 'SET outstandingBalance = if_not_exists(outstandingBalance, :zero) + :change, lastPaymentDate = :now, updatedAt = :now',
    ExpressionAttributeValues: {
      ':zero': 0,
      ':change': balanceChange,
      ':now': new Date().toISOString(),
    },
  }));
}

/**
 * Get patient
 */
async function getPatient(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: {
      patientId,
      recordType: 'PROFILE',
    },
  }));

  return result.Item;
}

/**
 * Get secret from Secrets Manager
 */
async function getSecret(secretName: string): Promise<any> {
  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await secretsManager.send(command);
  return JSON.parse(response.SecretString || '{}');
}

/**
 * Emit event to EventBridge
 */
async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [
      {
        EventBusName: EVENT_BUS_NAME,
        Source: 'medcx.payments',
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
