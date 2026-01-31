import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import Stripe from 'stripe';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});
const eventBridge = new EventBridgeClient({});
const secretsManager = new SecretsManagerClient({});

const PAYMENT_TABLE = process.env.PAYMENT_TABLE!;
const STRIPE_SECRET_ARN = process.env.STRIPE_SECRET_ARN!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

let stripeClient: Stripe | null = null;
let webhookSecret: string | null = null;

/**
 * Payment Webhook Lambda
 *
 * Handles Stripe webhook events:
 * - Payment intent succeeded/failed
 * - Subscription updates
 * - Refunds
 * - Disputes
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Payment Webhook Event received');

  try {
    const stripe = await getStripeClient();
    const secret = await getWebhookSecret();

    // Get signature from headers
    const signature = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];

    if (!signature) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing stripe-signature header' }),
      };
    }

    // Verify webhook signature
    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        signature,
        secret
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid signature' }),
      };
    }

    // Handle the event
    const result = await handleStripeEvent(stripeEvent);

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, result }),
    };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Webhook processing failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};

/**
 * Handle Stripe webhook event
 */
async function handleStripeEvent(event: Stripe.Event): Promise<any> {
  console.log('Processing Stripe event:', event.type);

  switch (event.type) {
    case 'payment_intent.succeeded':
      return handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);

    case 'payment_intent.payment_failed':
      return handlePaymentFailed(event.data.object as Stripe.PaymentIntent);

    case 'payment_intent.canceled':
      return handlePaymentCanceled(event.data.object as Stripe.PaymentIntent);

    case 'charge.refunded':
      return handleChargeRefunded(event.data.object as Stripe.Charge);

    case 'charge.dispute.created':
      return handleDisputeCreated(event.data.object as Stripe.Dispute);

    case 'customer.subscription.created':
      return handleSubscriptionCreated(event.data.object as Stripe.Subscription);

    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(event.data.object as Stripe.Subscription);

    case 'customer.subscription.deleted':
      return handleSubscriptionCanceled(event.data.object as Stripe.Subscription);

    case 'invoice.paid':
      return handleInvoicePaid(event.data.object as Stripe.Invoice);

    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);

    default:
      console.log('Unhandled event type:', event.type);
      return { handled: false, eventType: event.type };
  }
}

/**
 * Handle successful payment
 */
async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<any> {
  const paymentId = paymentIntent.metadata.paymentId;
  const patientId = paymentIntent.metadata.patientId;
  const now = new Date().toISOString();

  if (!paymentId) {
    console.log('No paymentId in metadata, skipping');
    return { skipped: true };
  }

  // Update payment record
  await docClient.send(new UpdateCommand({
    TableName: PAYMENT_TABLE,
    Key: { paymentId },
    UpdateExpression: 'SET #status = :status, completedAt = :completed, updatedAt = :updated',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'completed',
      ':completed': now,
      ':updated': now,
    },
  }));

  // Notify patient
  if (patientId) {
    const amount = paymentIntent.amount / 100;
    await notifyPatient(patientId, 'payment_success', {
      amount,
      paymentType: paymentIntent.metadata.paymentType || 'payment',
    });
  }

  // Emit event
  await emitEvent('PaymentCompleted', {
    paymentId,
    patientId,
    amount: paymentIntent.amount / 100,
    stripePaymentIntentId: paymentIntent.id,
    timestamp: now,
  });

  return { success: true, paymentId };
}

/**
 * Handle failed payment
 */
async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent): Promise<any> {
  const paymentId = paymentIntent.metadata.paymentId;
  const patientId = paymentIntent.metadata.patientId;
  const now = new Date().toISOString();

  if (!paymentId) {
    return { skipped: true };
  }

  const errorMessage = paymentIntent.last_payment_error?.message || 'Payment failed';

  // Update payment record
  await docClient.send(new UpdateCommand({
    TableName: PAYMENT_TABLE,
    Key: { paymentId },
    UpdateExpression: 'SET #status = :status, errorMessage = :error, updatedAt = :updated',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'failed',
      ':error': errorMessage,
      ':updated': now,
    },
  }));

  // Notify patient
  if (patientId) {
    await notifyPatient(patientId, 'payment_failed', {
      reason: errorMessage,
    });
  }

  // Emit event
  await emitEvent('PaymentFailed', {
    paymentId,
    patientId,
    error: errorMessage,
    timestamp: now,
  });

  return { success: false, paymentId, error: errorMessage };
}

/**
 * Handle canceled payment
 */
async function handlePaymentCanceled(paymentIntent: Stripe.PaymentIntent): Promise<any> {
  const paymentId = paymentIntent.metadata.paymentId;
  const now = new Date().toISOString();

  if (!paymentId) {
    return { skipped: true };
  }

  await docClient.send(new UpdateCommand({
    TableName: PAYMENT_TABLE,
    Key: { paymentId },
    UpdateExpression: 'SET #status = :status, cancelledAt = :cancelled, updatedAt = :updated',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'cancelled',
      ':cancelled': now,
      ':updated': now,
    },
  }));

  return { cancelled: true, paymentId };
}

/**
 * Handle refund
 */
async function handleChargeRefunded(charge: Stripe.Charge): Promise<any> {
  const paymentIntentId = charge.payment_intent as string;
  const now = new Date().toISOString();

  // Find payment by Stripe payment intent ID
  const result = await docClient.send(new QueryCommand({
    TableName: PAYMENT_TABLE,
    IndexName: 'stripe-intent-index',
    KeyConditionExpression: 'stripePaymentIntentId = :intentId',
    ExpressionAttributeValues: { ':intentId': paymentIntentId },
  }));

  const payment = result.Items?.[0];
  if (!payment) {
    return { skipped: true };
  }

  const refundAmount = charge.amount_refunded / 100;

  await docClient.send(new UpdateCommand({
    TableName: PAYMENT_TABLE,
    Key: { paymentId: payment.paymentId },
    UpdateExpression: 'SET #status = :status, refundAmount = :refundAmount, refundedAt = :refunded, updatedAt = :updated',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': charge.refunded ? 'refunded' : 'partially_refunded',
      ':refundAmount': refundAmount,
      ':refunded': now,
      ':updated': now,
    },
  }));

  // Notify patient
  if (payment.patientId) {
    await notifyPatient(payment.patientId, 'refund_processed', {
      amount: refundAmount,
    });
  }

  await emitEvent('PaymentRefunded', {
    paymentId: payment.paymentId,
    patientId: payment.patientId,
    refundAmount,
    timestamp: now,
  });

  return { refunded: true, paymentId: payment.paymentId, refundAmount };
}

/**
 * Handle dispute
 */
async function handleDisputeCreated(dispute: Stripe.Dispute): Promise<any> {
  const chargeId = dispute.charge as string;
  const now = new Date().toISOString();

  // Log dispute for review
  console.log('Dispute created:', {
    disputeId: dispute.id,
    chargeId,
    amount: dispute.amount / 100,
    reason: dispute.reason,
  });

  await emitEvent('PaymentDisputed', {
    disputeId: dispute.id,
    chargeId,
    amount: dispute.amount / 100,
    reason: dispute.reason,
    timestamp: now,
  });

  return { disputed: true, disputeId: dispute.id };
}

/**
 * Handle subscription created
 */
async function handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<any> {
  const patientId = subscription.metadata.patientId;
  const now = new Date().toISOString();

  await emitEvent('SubscriptionCreated', {
    subscriptionId: subscription.id,
    patientId,
    status: subscription.status,
    timestamp: now,
  });

  return { subscriptionCreated: true, subscriptionId: subscription.id };
}

/**
 * Handle subscription updated
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<any> {
  const patientId = subscription.metadata.patientId;
  const now = new Date().toISOString();

  await emitEvent('SubscriptionUpdated', {
    subscriptionId: subscription.id,
    patientId,
    status: subscription.status,
    timestamp: now,
  });

  return { subscriptionUpdated: true, subscriptionId: subscription.id };
}

/**
 * Handle subscription canceled
 */
async function handleSubscriptionCanceled(subscription: Stripe.Subscription): Promise<any> {
  const patientId = subscription.metadata.patientId;
  const now = new Date().toISOString();

  if (patientId) {
    await notifyPatient(patientId, 'subscription_cancelled', {});
  }

  await emitEvent('SubscriptionCanceled', {
    subscriptionId: subscription.id,
    patientId,
    timestamp: now,
  });

  return { subscriptionCanceled: true, subscriptionId: subscription.id };
}

/**
 * Handle invoice paid
 */
async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<any> {
  const subscriptionId = invoice.subscription as string;
  const patientId = invoice.metadata?.patientId;
  const now = new Date().toISOString();

  if (subscriptionId && patientId) {
    // Update remaining payments count
    const remainingPayments = parseInt(invoice.metadata?.remainingPayments || '0') - 1;

    if (remainingPayments <= 0) {
      // Payment plan complete
      await notifyPatient(patientId, 'payment_plan_complete', {});
    } else {
      await notifyPatient(patientId, 'payment_plan_payment', {
        amount: (invoice.amount_paid || 0) / 100,
        remainingPayments,
      });
    }
  }

  await emitEvent('InvoicePaid', {
    invoiceId: invoice.id,
    subscriptionId,
    patientId,
    amount: (invoice.amount_paid || 0) / 100,
    timestamp: now,
  });

  return { invoicePaid: true, invoiceId: invoice.id };
}

/**
 * Handle invoice payment failed
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<any> {
  const patientId = invoice.metadata?.patientId;
  const now = new Date().toISOString();

  if (patientId) {
    await notifyPatient(patientId, 'payment_plan_failed', {
      amount: (invoice.amount_due || 0) / 100,
    });
  }

  await emitEvent('InvoicePaymentFailed', {
    invoiceId: invoice.id,
    patientId,
    amount: (invoice.amount_due || 0) / 100,
    timestamp: now,
  });

  return { invoiceFailed: true, invoiceId: invoice.id };
}

// Helper functions
async function getStripeClient(): Promise<Stripe> {
  if (stripeClient) return stripeClient;

  const secretResponse = await secretsManager.send(new GetSecretValueCommand({
    SecretId: STRIPE_SECRET_ARN,
  }));

  const secrets = JSON.parse(secretResponse.SecretString || '{}');
  stripeClient = new Stripe(secrets.secretKey, { apiVersion: '2023-10-16' });
  webhookSecret = secrets.webhookSecret;
  return stripeClient;
}

async function getWebhookSecret(): Promise<string> {
  if (webhookSecret) return webhookSecret;

  const secretResponse = await secretsManager.send(new GetSecretValueCommand({
    SecretId: STRIPE_SECRET_ARN,
  }));

  const secrets = JSON.parse(secretResponse.SecretString || '{}');
  webhookSecret = secrets.webhookSecret;
  return webhookSecret!;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

async function notifyPatient(patientId: string, notificationType: string, data: any): Promise<void> {
  const messages: Record<string, string> = {
    payment_success: `Thank you! Your ${data.paymentType} payment of ${formatCurrency(data.amount)} has been processed.`,
    payment_failed: `Your payment could not be processed: ${data.reason}. Please try again or update your payment method.`,
    refund_processed: `A refund of ${formatCurrency(data.amount)} has been processed to your account.`,
    subscription_cancelled: 'Your payment plan has been cancelled.',
    payment_plan_complete: 'Congratulations! Your payment plan is complete. Thank you!',
    payment_plan_payment: `Payment of ${formatCurrency(data.amount)} received. ${data.remainingPayments} payments remaining.`,
    payment_plan_failed: `Your scheduled payment of ${formatCurrency(data.amount)} failed. Please update your payment method.`,
  };

  const message = messages[notificationType] || 'Payment update.';

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
