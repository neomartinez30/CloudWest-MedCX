import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';

const bedrockClient = new BedrockRuntimeClient({});
const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});

const CONVERSATION_LOG_TABLE = process.env.CONVERSATION_LOG_TABLE!;
const CONTEXT_BUILDER_ARN = process.env.CONTEXT_BUILDER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const MODEL_ID = process.env.MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationRequest {
  patientId: string;
  message: string;
  channel?: string;
  conversationHistory?: ConversationMessage[];
  systemPrompt?: string;
  intent?: string;
}

/**
 * Bedrock Conversation Lambda
 *
 * Powers AI conversations using Amazon Bedrock:
 * - Manages multi-turn conversations with Claude
 * - Integrates patient context for personalized responses
 * - Handles intent detection and routing
 * - Supports tool use for appointment scheduling
 * - Logs conversations for analytics
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Bedrock Conversation Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...data } = event;

    switch (action) {
      case 'converse':
        return handleConversation(data);

      case 'detectIntent':
        return detectIntent(data.message, data.context);

      case 'generateResponse':
        return generateResponse(data);

      case 'summarizeConversation':
        return summarizeConversation(data.conversationId);

      case 'getRecommendedActions':
        return getRecommendedActions(data.patientId, data.context);

      default:
        return handleConversation(data);
    }
  } catch (error) {
    console.error('Error in Bedrock conversation:', error);
    return {
      error: 'Conversation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Handle a conversation turn
 */
async function handleConversation(request: ConversationRequest): Promise<any> {
  const { patientId, message, channel, conversationHistory = [], intent } = request;
  const conversationId = uuidv4();

  // Build patient context
  const patientContext = await invokeFunction(CONTEXT_BUILDER_ARN, {
    action: 'buildFullContext',
    patientId,
  });

  // Format context for Bedrock
  const formattedContext = await invokeFunction(CONTEXT_BUILDER_ARN, {
    action: 'formatForBedrock',
    context: patientContext,
    intent,
  });

  // Detect intent if not provided
  const detectedIntent = intent || await detectIntent(message, formattedContext);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(formattedContext, detectedIntent);

  // Build messages array
  const messages = [
    ...conversationHistory,
    { role: 'user' as const, content: message },
  ];

  // Generate response using Bedrock
  const response = await invokeBedrockConverse(systemPrompt, messages);

  // Log the conversation
  await logConversation({
    conversationId,
    patientId,
    channel,
    userMessage: message,
    assistantResponse: response.content,
    intent: detectedIntent,
    context: formattedContext,
  });

  // Emit event for analytics
  await emitEvent('ConversationTurn', {
    conversationId,
    patientId,
    channel,
    intent: detectedIntent,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    conversationId,
    response: response.content,
    intent: detectedIntent,
    suggestedActions: response.suggestedActions || [],
    shouldHandoff: response.shouldHandoff || false,
  };
}

/**
 * Detect intent from message
 */
async function detectIntent(message: string, context?: string): Promise<string> {
  const intentPrompt = `Analyze the following message and determine the primary intent.
Respond with ONLY one of these intents:
- schedule_appointment
- reschedule_appointment
- cancel_appointment
- check_appointment
- billing_question
- insurance_question
- prescription_refill
- speak_to_human
- general_question
- greeting
- goodbye

${context ? `Context:\n${context}\n` : ''}
Message: "${message}"

Intent:`;

  const response = await invokeBedrockDirect(intentPrompt);
  return response.trim().toLowerCase().replace(/[^a-z_]/g, '');
}

/**
 * Generate a response for a specific scenario
 */
async function generateResponse(data: {
  patientId: string;
  scenario: string;
  variables?: Record<string, string>;
}): Promise<any> {
  const { patientId, scenario, variables = {} } = data;

  // Get patient context
  const summary = await invokeFunction(CONTEXT_BUILDER_ARN, {
    action: 'summarizeContext',
    patientId,
  });

  const templates: Record<string, string> = {
    appointment_confirmation: `Generate a friendly appointment confirmation message for ${summary.summary?.name || 'the patient'}.
      Appointment: ${variables.date} at ${variables.time} with ${variables.provider}.
      Keep it brief and professional.`,

    appointment_reminder: `Generate a friendly reminder for an upcoming appointment.
      Patient: ${summary.summary?.name || 'Patient'}
      Appointment: ${variables.date} at ${variables.time}
      Include a prompt to confirm or reschedule.`,

    reschedule_options: `Generate a message offering rescheduling options for ${summary.summary?.name || 'the patient'}.
      Available times: ${variables.availableSlots}
      Be helpful and accommodating.`,

    payment_reminder: `Generate a gentle payment reminder for ${summary.summary?.name || 'the patient'}.
      Amount: ${variables.amount}
      Due: ${variables.dueDate}
      Include payment options.`,
  };

  const prompt = templates[scenario] || `Generate a helpful response for: ${scenario}`;
  const response = await invokeBedrockDirect(prompt);

  return {
    success: true,
    message: response.trim(),
    scenario,
  };
}

/**
 * Summarize a conversation
 */
async function summarizeConversation(conversationId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_LOG_TABLE,
    KeyConditionExpression: 'conversationId = :conversationId',
    ExpressionAttributeValues: { ':conversationId': conversationId },
  }));

  const messages = result.Items || [];
  if (messages.length === 0) {
    return { error: 'Conversation not found' };
  }

  const conversationText = messages
    .map((m: any) => `User: ${m.userMessage}\nAssistant: ${m.assistantResponse}`)
    .join('\n\n');

  const summaryPrompt = `Summarize the following conversation between a patient and a medical clinic assistant.
Include:
1. Main topics discussed
2. Any actions taken or promised
3. Patient's primary concern
4. Outcome or next steps

Conversation:
${conversationText}

Summary:`;

  const summary = await invokeBedrockDirect(summaryPrompt);

  return {
    conversationId,
    messageCount: messages.length,
    summary: summary.trim(),
  };
}

/**
 * Get recommended actions based on conversation context
 */
async function getRecommendedActions(patientId: string, context?: any): Promise<any> {
  const patientContext = context || await invokeFunction(CONTEXT_BUILDER_ARN, {
    action: 'buildFullContext',
    patientId,
  });

  const prompt = `Based on this patient context, suggest up to 3 helpful actions the system could offer:

${JSON.stringify(patientContext, null, 2)}

Respond in JSON format:
{
  "actions": [
    {"id": "action_id", "label": "Button Label", "description": "Why this is helpful"}
  ]
}`;

  const response = await invokeBedrockDirect(prompt);

  try {
    const parsed = JSON.parse(response);
    return parsed;
  } catch {
    return { actions: [] };
  }
}

/**
 * Build system prompt with context
 */
function buildSystemPrompt(context: string, intent?: string): string {
  let prompt = `You are a helpful, friendly AI assistant for a medical clinic. You help patients with:
- Scheduling, rescheduling, and canceling appointments
- Answering questions about their appointments
- General clinic information
- Routing to appropriate staff when needed

Guidelines:
- Be warm, professional, and empathetic
- Keep responses concise but helpful
- Never provide medical advice - direct medical questions to providers
- Protect patient privacy - don't share sensitive information
- If you can't help, offer to connect them with a human agent

Patient Context:
${context}

`;

  if (intent) {
    prompt += `\nThe patient's current intent appears to be: ${intent}\n`;
  }

  prompt += `\nRespond naturally and helpfully to the patient's message.`;

  return prompt;
}

/**
 * Invoke Bedrock Converse API
 */
async function invokeBedrockConverse(
  systemPrompt: string,
  messages: ConversationMessage[]
): Promise<{ content: string; suggestedActions?: string[]; shouldHandoff?: boolean }> {
  const command = new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: systemPrompt }],
    messages: messages.map(m => ({
      role: m.role,
      content: [{ text: m.content }],
    })),
    inferenceConfig: {
      maxTokens: 500,
      temperature: 0.7,
      topP: 0.9,
    },
  });

  const response = await bedrockClient.send(command);

  const content = response.output?.message?.content?.[0]?.text || '';

  // Check for handoff indicators
  const shouldHandoff = content.toLowerCase().includes('speak to') ||
    content.toLowerCase().includes('human agent') ||
    content.toLowerCase().includes('transfer you');

  return {
    content,
    shouldHandoff,
  };
}

/**
 * Direct Bedrock invocation for simple prompts
 */
async function invokeBedrockDirect(prompt: string): Promise<string> {
  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  return responseBody.content?.[0]?.text || '';
}

/**
 * Log conversation turn
 */
async function logConversation(data: {
  conversationId: string;
  patientId: string;
  channel?: string;
  userMessage: string;
  assistantResponse: string;
  intent?: string;
  context?: string;
}): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: CONVERSATION_LOG_TABLE,
    Item: {
      conversationId: data.conversationId,
      timestamp: new Date().toISOString(),
      patientId: data.patientId,
      channel: data.channel,
      userMessage: data.userMessage,
      assistantResponse: data.assistantResponse,
      intent: data.intent,
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60),
    },
  }));
}

/**
 * Helper to invoke other Lambda functions
 */
async function invokeFunction(functionArn: string, payload: any): Promise<any> {
  const command = new InvokeCommand({
    FunctionName: functionArn,
    Payload: JSON.stringify(payload),
  });
  const response = await lambdaClient.send(command);
  return JSON.parse(new TextDecoder().decode(response.Payload));
}

/**
 * Emit EventBridge event
 */
async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [{
      EventBusName: EVENT_BUS_NAME,
      Source: 'medcx.genai',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
