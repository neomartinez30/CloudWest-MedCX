import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});
const eventBridge = new EventBridgeClient({});
const secretsManager = new SecretsManagerClient({});

const PAYMENT_TABLE = process.env.PAYMENT_TABLE!;
const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const STRIPE_SECRET_ARN = process.env.STRIPE_SECRET_ARN!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const PORTAL_URL = process.env.PORTAL_URL!;

type PaymentType = 'copay' | 'deductible' | 'balance' | 'self_pay' | 'other';
type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded' | 'cancelled';

interface PaymentRequest {
  patientId: string;
  amount: number;
  paymentType: PaymentType;
  description?: string;
  appointmentId?: string;
  metadata?: Record<string, string>;
}

interface PaymentResult {
  success: boolean;
  paymentId: string;
  status: PaymentStatus;
  transactionId?: string;
  error?: string;
}

let stripeClient: Stripe | null = null;

/**
 * Payment Processor Lambda
 *
 * Handles patient payments via Stripe:
 * - Create payment intents
 * - Process payments
 * - Send payment links via SMS
 * - Track payment status
 * - Issue refunds
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Payment Processor Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...data } = event;

    switch (action) {
      case 'createPaymentIntent':
        return createPaymentIntent(data);

      case 'processPayment':
        return processPayment(data);

      case 'sendPaymentLink':
        return sendPaymentLink(data);

      case 'getPaymentStatus':
        return getPaymentStatus(data.paymentId);

      case 'getPatientPayments':
        return getPatientPayments(data.patientId);

      case 'refundPayment':
        return refundPayment(data);

      case 'getPatientBalance':
        return getPatientBalance(data.patientId);

      case 'createSubscription':
        return createSubscription(data);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in payment processor:', error);
    return {
      error: 'Payment processing failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Create a payment intent
 */
async function createPaymentIntent(request: PaymentRequest): Promise<any> {
  const { patientId, amount, paymentType, description, appointmentId, metadata } = request;
  const paymentId = randomUUID();
  const now = new Date().toISOString();

  // Get or create Stripe customer
  const stripe = await getStripeClient();
  const patient = await getPatient(patientId);

  if (!patient) {
    return { error: 'Patient not found' };
  }

  let stripeCustomerId = patient.stripeCustomerId;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: patient.email,
      phone: patient.phoneNumber,
      name: `${patient.firstName} ${patient.lastName}`,
      metadata: { patientId },
    });
    stripeCustomerId = customer.id;

    // Update patient with Stripe customer ID
    await updatePatientStripeId(patientId, stripeCustomerId);
  }

  // Create payment intent
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // Convert to cents
    currency: 'usd',
    customer: stripeCustomerId,
    description: description || `${paymentType} payment`,
    metadata: {
      patientId,
      paymentId,
      paymentType,
      appointmentId: appointmentId || '',
      ...metadata,
    },
  });

  // Store payment record
  await docClient.send(new PutCommand({
    TableName: PAYMENT_TABLE,
    Item: {
      paymentId,
      patientId,
      amount,
      paymentType,
      description,
      appointmentId,
      status: 'pending',
      stripePaymentIntentId: paymentIntent.id,
      stripeCustomerId,
      clientSecret: paymentIntent.client_secret,
      createdAt: now,
      updatedAt: now,
    },
  }));

  // Emit event
  await emitEvent('PaymentIntentCreated', {
    paymentId,
    patientId,
    amount,
    paymentType,
    timestamp: now,
  });

  return {
    success: true,
    paymentId,
    clientSecret: paymentIntent.client_secret,
    paymentUrl: `${PORTAL_URL}/pay/${paymentId}`,
  };
}

/**
 * Process a payment (after client-side confirmation)
 */
async function processPayment(data: {
  paymentId: string;
  paymentMethodId?: string;
}): Promise<PaymentResult> {
  const { paymentId, paymentMethodId } = data;
  const now = new Date().toISOString();

  // Get payment record
  const paymentResult = await docClient.send(new GetCommand({
    TableName: PAYMENT_TABLE,
    Key: { paymentId },
  }));

  const payment = paymentResult.Item;
  if (!payment) {
    return { success: false, paymentId, status: 'failed', error: 'Payment not found' };
  }

  const stripe = await getStripeClient();

  try {
    // Confirm the payment intent if payment method provided
    if (paymentMethodId) {
      await stripe.paymentIntents.confirm(payment.stripePaymentIntentId, {
        payment_method: paymentMethodId,
      });
    }

    // Retrieve payment intent status
    const paymentIntent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);

    let status: PaymentStatus = 'pending';
    if (paymentIntent.status === 'succeeded') {
      status = 'completed';
    } else if (paymentIntent.status === 'processing') {
      status = 'processing';
    } else if (paymentIntent.status === 'requires_payment_method' || paymentIntent.status === 'canceled') {
      status = 'failed';
    }

    // Update payment record
    await docClient.send(new UpdateCommand({
      TableName: PAYMENT_TABLE,
      Key: { paymentId },
      UpdateExpression: 'SET #status = :status, transactionId = :txId, updatedAt = :updated',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':txId': paymentIntent.id,
        ':updated': now,
      },
    }));

    if (status === 'completed') {
      // Notify patient
      await notifyPatient(payment.patientId, 'payment_success', {
        amount: payment.amount,
        paymentType: payment.paymentType,
      });

      // Emit event
      await emitEvent('PaymentCompleted', {
        paymentId,
        patientId: payment.patientId,
        amount: payment.amount,
        timestamp: now,
      });
    }

    return {
      success: status === 'completed',
      paymentId,
      status,
      transactionId: paymentIntent.id,
    };
  } catch (error) {
    // Update with error
    await docClient.send(new UpdateCommand({
      TableName: PAYMENT_TABLE,
      Key: { paymentId },
      UpdateExpression: 'SET #status = :status, errorMessage = :error, updatedAt = :updated',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'failed',
        ':error': error instanceof Error ? error.message : 'Unknown error',
        ':updated': now,
      },
    }));

    return {
      success: false,
      paymentId,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Payment failed',
    };
  }
}

/**
 * Send payment link to patient
 */
async function sendPaymentLink(data: PaymentRequest): Promise<any> {
  // Create payment intent first
  const paymentIntent = await createPaymentIntent(data);

  if (!paymentIntent.success) {
    return paymentIntent;
  }

  const paymentUrl = paymentIntent.paymentUrl;
  const formattedAmount = formatCurrency(data.amount);

  // Send SMS with payment link
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendOutbound',
    channel: 'sms',
    patientId: data.patientId,
    content: `Your ${data.paymentType} payment of ${formattedAmount} is ready. Pay securely here: ${paymentUrl}`,
  });

  // Also try to send rich link via Apple Messages if available
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendInteractive',
    patientId: data.patientId,
    interactiveType: 'rich_link',
    payload: {
      title: `Pay ${formattedAmount} - ${data.paymentType}`,
      url: paymentUrl,
    },
  });

  return {
    success: true,
    paymentId: paymentIntent.paymentId,
    paymentUrl,
    messageSent: true,
  };
}

/**
 * Get payment status
 */
async function getPaymentStatus(paymentId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PAYMENT_TABLE,
    Key: { paymentId },
  }));

  if (!result.Item) {
    return { error: 'Payment not found' };
  }

  // Get latest status from Stripe
  const stripe = await getStripeClient();
  const paymentIntent = await stripe.paymentIntents.retrieve(result.Item.stripePaymentIntentId);

  return {
    paymentId,
    amount: result.Item.amount,
    paymentType: result.Item.paymentType,
    status: result.Item.status,
    stripeStatus: paymentIntent.status,
    createdAt: result.Item.createdAt,
  };
}

/**
 * Get patient payments
 */
async function getPatientPayments(patientId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: PAYMENT_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
  }));

  const payments = result.Items || [];

  return {
    patientId,
    payments,
    totalPending: payments
      .filter((p: any) => p.status === 'pending')
      .reduce((sum: number, p: any) => sum + p.amount, 0),
    totalCompleted: payments
      .filter((p: any) => p.status === 'completed')
      .reduce((sum: number, p: any) => sum + p.amount, 0),
  };
}

/**
 * Refund a payment
 */
async function refundPayment(data: {
  paymentId: string;
  amount?: number;
  reason?: string;
}): Promise<any> {
  const { paymentId, amount, reason } = data;
  const now = new Date().toISOString();

  const paymentResult = await docClient.send(new GetCommand({
    TableName: PAYMENT_TABLE,
    Key: { paymentId },
  }));

  const payment = paymentResult.Item;
  if (!payment) {
    return { error: 'Payment not found' };
  }

  if (payment.status !== 'completed') {
    return { error: 'Can only refund completed payments' };
  }

  const stripe = await getStripeClient();

  try {
    const refundParams: Stripe.RefundCreateParams = {
      payment_intent: payment.stripePaymentIntentId,
      reason: 'requested_by_customer',
      metadata: { reason: reason || 'Customer request' },
    };

    if (amount && amount < payment.amount) {
      refundParams.amount = Math.round(amount * 100);
    }

    const refund = await stripe.refunds.create(refundParams);

    // Update payment record
    await docClient.send(new UpdateCommand({
      TableName: PAYMENT_TABLE,
      Key: { paymentId },
      UpdateExpression: 'SET #status = :status, refundId = :refundId, refundAmount = :refundAmount, refundReason = :reason, refundedAt = :refundedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'refunded',
        ':refundId': refund.id,
        ':refundAmount': amount || payment.amount,
        ':reason': reason,
        ':refundedAt': now,
      },
    }));

    // Notify patient
    await notifyPatient(payment.patientId, 'refund_processed', {
      amount: amount || payment.amount,
    });

    // Emit event
    await emitEvent('PaymentRefunded', {
      paymentId,
      patientId: payment.patientId,
      refundAmount: amount || payment.amount,
      timestamp: now,
    });

    return {
      success: true,
      paymentId,
      refundId: refund.id,
      refundAmount: amount || payment.amount,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Refund failed',
    };
  }
}

/**
 * Get patient balance
 */
async function getPatientBalance(patientId: string): Promise<any> {
  const payments = await getPatientPayments(patientId);

  // In production, this would also check for outstanding invoices
  const pendingAmount = payments.totalPending || 0;

  return {
    patientId,
    balance: pendingAmount,
    pendingPayments: payments.payments.filter((p: any) => p.status === 'pending'),
    hasOutstandingBalance: pendingAmount > 0,
  };
}

/**
 * Create payment subscription (for payment plans)
 */
async function createSubscription(data: {
  patientId: string;
  totalAmount: number;
  numberOfPayments: number;
  paymentType: PaymentType;
}): Promise<any> {
  const { patientId, totalAmount, numberOfPayments, paymentType } = data;
  const paymentAmount = Math.ceil((totalAmount / numberOfPayments) * 100) / 100;

  // Create subscription in Stripe
  const stripe = await getStripeClient();
  const patient = await getPatient(patientId);

  if (!patient?.stripeCustomerId) {
    return { error: 'Patient must have payment method on file' };
  }

  // Create a price for the payment plan
  const price = await stripe.prices.create({
    currency: 'usd',
    unit_amount: Math.round(paymentAmount * 100),
    recurring: { interval: 'month', interval_count: 1 },
    product_data: {
      name: `Payment Plan - ${paymentType}`,
      metadata: { patientId, paymentType },
    },
  });

  // Create subscription
  const subscription = await stripe.subscriptions.create({
    customer: patient.stripeCustomerId,
    items: [{ price: price.id }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    metadata: {
      patientId,
      totalAmount: totalAmount.toString(),
      remainingPayments: numberOfPayments.toString(),
    },
  });

  return {
    success: true,
    subscriptionId: subscription.id,
    paymentAmount,
    numberOfPayments,
    totalAmount,
  };
}

// Helper functions
async function getStripeClient(): Promise<Stripe> {
  if (stripeClient) return stripeClient;

  const secretResponse = await secretsManager.send(new GetSecretValueCommand({
    SecretId: STRIPE_SECRET_ARN,
  }));

  const secrets = JSON.parse(secretResponse.SecretString || '{}');
  stripeClient = new Stripe(secrets.secretKey, { apiVersion: '2023-10-16' });
  return stripeClient;
}

async function getPatient(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));
  return result.Item;
}

async function updatePatientStripeId(patientId: string, stripeCustomerId: string): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
    UpdateExpression: 'SET stripeCustomerId = :stripeId, updatedAt = :updated',
    ExpressionAttributeValues: {
      ':stripeId': stripeCustomerId,
      ':updated': new Date().toISOString(),
    },
  }));
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

async function notifyPatient(patientId: string, notificationType: string, data: any): Promise<void> {
  let message: string;

  switch (notificationType) {
    case 'payment_success':
      message = `Thank you! Your ${data.paymentType} payment of ${formatCurrency(data.amount)} has been processed successfully.`;
      break;

    case 'refund_processed':
      message = `A refund of ${formatCurrency(data.amount)} has been processed to your payment method.`;
      break;

    default:
      message = 'Payment update.';
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
      Source: 'medcx.payments',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
