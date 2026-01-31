import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const bedrockClient = new BedrockRuntimeClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0';

interface BedrockRequest {
  action: 'generateResponse' | 'analyzeIntent' | 'extractEntities' | 'summarizeConversation';
  patientId?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  userMessage: string;
  context?: Record<string, any>;
  systemPrompt?: string;
}

/**
 * Bedrock Integration Lambda
 *
 * Provides GenAI capabilities using Amazon Bedrock (Claude):
 * - Natural language understanding for appointment booking
 * - Context-aware response generation
 * - Intent analysis for complex queries
 * - Conversation summarization
 * - Entity extraction from patient messages
 */
export const handler = async (event: BedrockRequest): Promise<any> => {
  console.log('Bedrock Integration Event:', JSON.stringify(event, null, 2));

  try {
    const { action, patientId, userMessage, conversationHistory, context, systemPrompt } = event;

    // Get patient context if available
    let patientContext = {};
    if (patientId) {
      patientContext = await getPatientContext(patientId);
    }

    switch (action) {
      case 'generateResponse':
        return generateResponse(userMessage, conversationHistory || [], patientContext, systemPrompt);

      case 'analyzeIntent':
        return analyzeIntent(userMessage, patientContext);

      case 'extractEntities':
        return extractEntities(userMessage);

      case 'summarizeConversation':
        return summarizeConversation(conversationHistory || []);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in Bedrock integration:', error);
    return {
      error: 'Failed to process request',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Generate a context-aware response
 */
async function generateResponse(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
  patientContext: Record<string, any>,
  customSystemPrompt?: string
): Promise<any> {
  const systemPrompt = customSystemPrompt || buildMedicalAssistantPrompt(patientContext);

  const messages = [
    ...conversationHistory.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })),
    { role: 'user' as const, content: userMessage },
  ];

  const response = await invokeModel(systemPrompt, messages);

  return {
    response: response.content,
    confidence: response.stop_reason === 'end_turn' ? 'high' : 'medium',
    suggestedActions: extractSuggestedActions(response.content),
  };
}

/**
 * Analyze user intent
 */
async function analyzeIntent(
  userMessage: string,
  patientContext: Record<string, any>
): Promise<any> {
  const systemPrompt = `You are an intent classifier for a medical contact center. Analyze the user's message and determine their intent.

Available intents:
- schedule_appointment: User wants to book a new appointment
- check_appointment: User wants to know about their upcoming appointments
- cancel_appointment: User wants to cancel an appointment
- reschedule_appointment: User wants to change an existing appointment
- billing_inquiry: User has questions about bills or payments
- prescription_refill: User needs medication refill
- speak_to_agent: User wants to talk to a human
- general_question: General health-related question
- insurance_question: Questions about insurance coverage
- other: Doesn't fit other categories

Respond in JSON format:
{
  "primary_intent": "intent_name",
  "confidence": 0.0-1.0,
  "secondary_intent": "intent_name or null",
  "entities": { extracted entities },
  "sentiment": "positive|neutral|negative",
  "urgency": "low|medium|high"
}`;

  const response = await invokeModel(systemPrompt, [
    { role: 'user', content: userMessage },
  ]);

  try {
    return JSON.parse(response.content);
  } catch {
    return {
      primary_intent: 'other',
      confidence: 0.5,
      raw_response: response.content,
    };
  }
}

/**
 * Extract entities from user message
 */
async function extractEntities(userMessage: string): Promise<any> {
  const systemPrompt = `Extract relevant entities from the user's message for a medical appointment system.

Extract these entity types if present:
- date: Any date mentioned (convert to YYYY-MM-DD format)
- time: Any time mentioned (convert to HH:MM format)
- appointment_type: Type of appointment (checkup, follow-up, urgent, etc.)
- provider_name: Doctor or provider name
- symptoms: Any symptoms mentioned
- medication: Any medication mentioned
- phone_number: Phone number if mentioned
- email: Email address if mentioned

Respond in JSON format:
{
  "entities": {
    "date": "value or null",
    "time": "value or null",
    "appointment_type": "value or null",
    ...
  },
  "raw_text": "original message"
}`;

  const response = await invokeModel(systemPrompt, [
    { role: 'user', content: userMessage },
  ]);

  try {
    return JSON.parse(response.content);
  } catch {
    return {
      entities: {},
      raw_text: userMessage,
      extraction_failed: true,
    };
  }
}

/**
 * Summarize a conversation
 */
async function summarizeConversation(
  conversationHistory: Array<{ role: string; content: string }>
): Promise<any> {
  if (conversationHistory.length === 0) {
    return { summary: 'No conversation to summarize' };
  }

  const systemPrompt = `Summarize this medical contact center conversation concisely. Include:
- Main topic/reason for contact
- Key information provided by patient
- Outcome or resolution
- Any follow-up actions needed

Keep the summary under 100 words.`;

  const conversationText = conversationHistory
    .map(msg => `${msg.role}: ${msg.content}`)
    .join('\n');

  const response = await invokeModel(systemPrompt, [
    { role: 'user', content: conversationText },
  ]);

  return {
    summary: response.content,
    messageCount: conversationHistory.length,
  };
}

/**
 * Build the medical assistant system prompt
 */
function buildMedicalAssistantPrompt(patientContext: Record<string, any>): string {
  let prompt = `You are a helpful medical clinic assistant for CloudWest Medical. You help patients with:
- Scheduling, rescheduling, and canceling appointments
- Answering general questions about the clinic
- Providing information about their upcoming appointments
- Explaining billing and payment options
- Directing patients to appropriate resources

Guidelines:
- Be warm, professional, and empathetic
- Keep responses concise and helpful
- If you cannot help with something, offer to connect them with a human agent
- Never provide medical advice or diagnoses
- Protect patient privacy - don't repeat sensitive information unnecessarily
- If the patient seems upset or has an urgent medical need, prioritize getting them help

`;

  if (patientContext.patient) {
    prompt += `\nPatient Context:
- Name: ${patientContext.patient.firstName} ${patientContext.patient.lastName}
- Preferred Channel: ${patientContext.patient.preferredChannel || 'Not specified'}
`;

    if (patientContext.upcomingAppointments?.length > 0) {
      prompt += `- Upcoming Appointments: ${patientContext.upcomingAppointments.length}\n`;
    }

    if (patientContext.recentInteractions?.length > 0) {
      prompt += `- Recent Interactions: ${patientContext.recentInteractions.length} in the past 30 days\n`;
    }
  }

  return prompt;
}

/**
 * Invoke the Bedrock model
 */
async function invokeModel(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<{ content: string; stop_reason: string }> {
  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  };

  const command = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(requestBody),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  return {
    content: responseBody.content[0].text,
    stop_reason: responseBody.stop_reason,
  };
}

/**
 * Get patient context for personalization
 */
async function getPatientContext(patientId: string): Promise<Record<string, any>> {
  const [patientResult, appointmentsResult, interactionsResult] = await Promise.all([
    docClient.send(new GetCommand({
      TableName: PATIENT_TABLE,
      Key: { patientId, recordType: 'PROFILE' },
    })),
    docClient.send(new QueryCommand({
      TableName: APPOINTMENT_TABLE,
      IndexName: 'patient-index',
      KeyConditionExpression: 'patientId = :patientId AND appointmentDateTime >= :now',
      ExpressionAttributeValues: {
        ':patientId': patientId,
        ':now': new Date().toISOString(),
      },
      Limit: 5,
    })),
    docClient.send(new QueryCommand({
      TableName: CONVERSATION_TABLE,
      KeyConditionExpression: 'patientId = :patientId',
      ExpressionAttributeValues: {
        ':patientId': patientId,
      },
      Limit: 10,
      ScanIndexForward: false,
    })),
  ]);

  return {
    patient: patientResult.Item,
    upcomingAppointments: appointmentsResult.Items || [],
    recentInteractions: interactionsResult.Items || [],
  };
}

/**
 * Extract suggested actions from response
 */
function extractSuggestedActions(response: string): string[] {
  const actions: string[] = [];
  const lowerResponse = response.toLowerCase();

  if (lowerResponse.includes('schedule') || lowerResponse.includes('appointment')) {
    actions.push('offer_appointment_scheduling');
  }
  if (lowerResponse.includes('text') || lowerResponse.includes('sms')) {
    actions.push('offer_sms_handoff');
  }
  if (lowerResponse.includes('payment') || lowerResponse.includes('bill')) {
    actions.push('offer_payment_link');
  }
  if (lowerResponse.includes('agent') || lowerResponse.includes('representative')) {
    actions.push('offer_agent_transfer');
  }

  return actions;
}
