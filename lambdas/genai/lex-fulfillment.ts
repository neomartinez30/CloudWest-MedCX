import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';

const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new BedrockRuntimeClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const APPOINTMENT_SCHEDULER_ARN = process.env.APPOINTMENT_SCHEDULER_ARN!;
const IDENTITY_RESOLVER_ARN = process.env.IDENTITY_RESOLVER_ARN!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0';

interface LexEvent {
  sessionState: {
    sessionAttributes?: Record<string, string>;
    intent: {
      name: string;
      slots: Record<string, any>;
      state: string;
      confirmationState?: string;
    };
  };
  invocationSource: string;
  inputTranscript: string;
  requestAttributes?: Record<string, string>;
  sessionId: string;
}

interface ConversationContext {
  patientId?: string;
  patientName?: string;
  phoneNumber?: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentIntent?: string;
  pendingAction?: any;
  appointments?: any[];
}

const SYSTEM_PROMPT = `You are a friendly, helpful medical office assistant for CloudWest Medical Center. Your role is to help patients with:

1. **Scheduling appointments** - Help patients book new appointments
2. **Checking appointments** - Look up their upcoming appointments
3. **Cancelling/rescheduling** - Modify existing appointments
4. **Payments** - Check balance or help with payments
5. **Prescription refills** - Request medication refills
6. **General questions** - Office hours, location, etc.

## Important Guidelines:

- Be warm, conversational, and empathetic - patients may be anxious about health matters
- Keep responses concise for voice (2-3 sentences max unless listing information)
- Always confirm understanding before taking actions
- If you need information (like date/time for scheduling), ask naturally in conversation
- Offer to send details via text message when appropriate
- If you cannot help with something, offer to connect them with a human agent

## Available Actions (output these as JSON when needed):

When the patient confirms they want to take an action, respond with your message AND include a JSON action block:

\`\`\`action
{"action": "schedule_appointment", "appointmentType": "...", "date": "...", "time": "..."}
\`\`\`

\`\`\`action
{"action": "cancel_appointment", "appointmentId": "..."}
\`\`\`

\`\`\`action
{"action": "send_sms", "message": "...", "includeTimePicker": true}
\`\`\`

\`\`\`action
{"action": "transfer_to_agent", "reason": "..."}
\`\`\`

\`\`\`action
{"action": "check_appointments"}
\`\`\`

\`\`\`action
{"action": "end_call"}
\`\`\`

Use "end_call" when the patient says goodbye, thanks you and is done, or indicates they're finished with the call.

## Patient Context:
{PATIENT_CONTEXT}

## Current Date/Time: {CURRENT_DATETIME}

Remember: You're speaking to them on the phone, so be natural and conversational. Don't be robotic!`;

/**
 * Conversational Lex Fulfillment Lambda
 *
 * Uses Amazon Bedrock Claude for natural, GenAI-powered conversations.
 * Maintains context across turns and handles multi-turn dialogs naturally.
 */
export const handler = async (event: LexEvent): Promise<any> => {
  console.log('Conversational Lex Event:', JSON.stringify(event, null, 2));

  try {
    const userMessage = event.inputTranscript;
    const sessionAttributes = event.sessionState.sessionAttributes || {};

    // Build or restore conversation context
    const context = await buildContext(sessionAttributes, event.requestAttributes);

    // Add user message to history
    context.conversationHistory.push({ role: 'user', content: userMessage });

    // Generate response using Bedrock Claude
    const { response, action } = await generateConversationalResponse(context, userMessage);

    // Add assistant response to history
    context.conversationHistory.push({ role: 'assistant', content: response });

    // Execute any actions
    let finalResponse = response;
    let nextAction: 'continue' | 'completed' | 'send_sms' | 'end_call' = 'continue';
    let smsContext: string | undefined;

    if (action) {
      const actionResult = await executeAction(action, context);
      if (actionResult.additionalMessage) {
        finalResponse = actionResult.additionalMessage;
      }
      if (actionResult.transferToAgent) {
        return buildTransferResponse(event, context, finalResponse, action.reason);
      }

      // Determine nextAction based on the action type
      switch (action.action) {
        case 'schedule_appointment':
        case 'cancel_appointment':
        case 'check_appointments':
          nextAction = actionResult.success ? 'completed' : 'continue';
          break;
        case 'send_sms':
          nextAction = 'send_sms';
          smsContext = JSON.stringify({
            message: action.message,
            includeTimePicker: action.includeTimePicker,
          });
          break;
        case 'end_call':
          nextAction = 'end_call';
          break;
        default:
          nextAction = 'continue';
      }
    }

    // Save updated context
    await saveContext(context, sessionAttributes);

    return buildConversationalResponse(event, context, finalResponse, nextAction, smsContext);

  } catch (error) {
    console.error('Error in conversational fulfillment:', error);
    return buildErrorResponse(event,
      "I apologize, I'm having a little trouble right now. Would you like me to connect you with one of our team members?");
  }
};

/**
 * Build conversation context from session attributes
 */
async function buildContext(
  sessionAttributes: Record<string, string>,
  requestAttributes?: Record<string, string>
): Promise<ConversationContext> {
  let context: ConversationContext = {
    conversationHistory: [],
  };

  // Restore existing conversation history
  if (sessionAttributes.conversationHistory) {
    try {
      context.conversationHistory = JSON.parse(sessionAttributes.conversationHistory);
    } catch (e) {
      context.conversationHistory = [];
    }
  }

  // Resolve patient identity
  const phoneNumber = sessionAttributes.phoneNumber ||
                       requestAttributes?.['x-amz-lex:caller-id'] ||
                       requestAttributes?.['phoneNumber'];

  if (phoneNumber) {
    context.phoneNumber = phoneNumber;

    if (!sessionAttributes.patientId) {
      const identity = await resolvePatientIdentity(phoneNumber);
      if (identity?.patientId) {
        context.patientId = identity.patientId;
        context.patientName = `${identity.firstName || ''} ${identity.lastName || ''}`.trim();

        // Fetch upcoming appointments
        context.appointments = await getUpcomingAppointments(identity.patientId);
      }
    } else {
      context.patientId = sessionAttributes.patientId;
      context.patientName = sessionAttributes.patientName;

      if (!sessionAttributes.appointments) {
        context.appointments = await getUpcomingAppointments(sessionAttributes.patientId);
      } else {
        try {
          context.appointments = JSON.parse(sessionAttributes.appointments);
        } catch (e) {
          context.appointments = [];
        }
      }
    }
  }

  return context;
}

/**
 * Generate conversational response using Bedrock Claude
 */
async function generateConversationalResponse(
  context: ConversationContext,
  userMessage: string
): Promise<{ response: string; action?: any }> {

  // Build patient context for system prompt
  let patientContext = '';
  if (context.patientName) {
    patientContext += `Patient Name: ${context.patientName}\n`;
  }
  if (context.patientId) {
    patientContext += `Patient ID: ${context.patientId}\n`;
  }
  if (context.appointments && context.appointments.length > 0) {
    patientContext += `\nUpcoming Appointments:\n`;
    context.appointments.forEach((apt, i) => {
      patientContext += `${i + 1}. ${apt.appointmentType || 'Appointment'} on ${apt.appointmentDate} at ${apt.appointmentTime}\n`;
    });
  } else {
    patientContext += `\nNo upcoming appointments on file.\n`;
  }

  const systemPrompt = SYSTEM_PROMPT
    .replace('{PATIENT_CONTEXT}', patientContext || 'New patient - no records found yet')
    .replace('{CURRENT_DATETIME}', new Date().toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }));

  // Build messages for Bedrock
  const messages = context.conversationHistory.map(msg => ({
    role: msg.role as 'user' | 'assistant',
    content: [{ text: msg.content }],
  }));

  try {
    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages,
      inferenceConfig: {
        maxTokens: 500,
        temperature: 0.7,
        topP: 0.9,
      },
    });

    const bedrockResponse = await bedrockClient.send(command);
    const responseText = bedrockResponse.output?.message?.content?.[0]?.text || '';

    // Parse any action from the response
    const action = parseAction(responseText);
    const cleanResponse = removeActionBlock(responseText);

    return { response: cleanResponse, action };

  } catch (error) {
    console.error('Bedrock error:', error);
    return {
      response: "I'd be happy to help you. Could you tell me what you'd like to do today? " +
                "I can help with scheduling, checking appointments, or connecting you with our team."
    };
  }
}

/**
 * Parse action JSON from response
 */
function parseAction(response: string): any | null {
  const actionMatch = response.match(/```action\n([\s\S]*?)\n```/);
  if (actionMatch) {
    try {
      return JSON.parse(actionMatch[1]);
    } catch (e) {
      console.error('Failed to parse action:', e);
    }
  }
  return null;
}

/**
 * Remove action block from response
 */
function removeActionBlock(response: string): string {
  return response.replace(/```action\n[\s\S]*?\n```/g, '').trim();
}

/**
 * Execute parsed action
 */
async function executeAction(
  action: any,
  context: ConversationContext
): Promise<{ success: boolean; additionalMessage?: string; transferToAgent?: boolean }> {

  console.log('Executing action:', action);

  switch (action.action) {
    case 'schedule_appointment':
      if (!context.patientId) {
        return {
          success: false,
          additionalMessage: "I'd love to help you schedule, but I need to verify your information first. Can you confirm your phone number?"
        };
      }

      const scheduleResult = await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
        action: 'scheduleAppointment',
        patientId: context.patientId,
        appointmentType: action.appointmentType,
        preferredDate: action.date,
        preferredTime: action.time,
        sendCalendarInvite: true,
      });

      if (scheduleResult.success) {
        // Record in conversation history
        await recordConversation(context.patientId, 'system',
          `Scheduled ${action.appointmentType} for ${action.date} at ${action.time}`, 'appointment_scheduled');
        return { success: true };
      }

      return {
        success: false,
        additionalMessage: "Hmm, that time slot isn't available. Would you like me to suggest some alternatives?"
      };

    case 'cancel_appointment':
      const cancelResult = await invokeFunction(APPOINTMENT_SCHEDULER_ARN, {
        action: 'cancelAppointment',
        appointmentId: action.appointmentId,
        patientId: context.patientId,
      });

      return { success: cancelResult.success };

    case 'check_appointments':
      // Already have appointments in context, no additional action needed
      return { success: true };

    case 'send_sms':
      if (context.phoneNumber) {
        await invokeFunction(CHANNEL_ROUTER_ARN, {
          action: 'sendOutbound',
          channel: 'sms',
          patientId: context.patientId,
          phoneNumber: context.phoneNumber,
          content: action.message,
          includeTimePicker: action.includeTimePicker,
        });
        return { success: true };
      }
      return { success: false };

    case 'transfer_to_agent':
      return { success: true, transferToAgent: true };

    case 'end_call':
      return { success: true };

    default:
      return { success: false };
  }
}

/**
 * Save conversation context to session attributes
 */
async function saveContext(
  context: ConversationContext,
  sessionAttributes: Record<string, string>
): Promise<void> {
  // Keep last 10 turns to avoid session attribute size limits
  const recentHistory = context.conversationHistory.slice(-10);

  sessionAttributes.conversationHistory = JSON.stringify(recentHistory);
  sessionAttributes.patientId = context.patientId || '';
  sessionAttributes.patientName = context.patientName || '';
  sessionAttributes.phoneNumber = context.phoneNumber || '';

  if (context.appointments) {
    sessionAttributes.appointments = JSON.stringify(context.appointments);
  }
}

/**
 * Build conversational Lex response
 */
function buildConversationalResponse(
  event: LexEvent,
  context: ConversationContext,
  message: string,
  nextAction: 'continue' | 'completed' | 'send_sms' | 'end_call',
  smsContext?: string
): any {
  const sessionAttributes = event.sessionState.sessionAttributes || {};

  // Update session attributes for Connect flow
  sessionAttributes.conversationHistory = JSON.stringify(context.conversationHistory.slice(-10));
  sessionAttributes.patientId = context.patientId || '';
  sessionAttributes.patientName = context.patientName || '';
  sessionAttributes.assistantResponse = message;
  sessionAttributes.nextAction = nextAction;

  if (smsContext) {
    sessionAttributes.smsContext = smsContext;
  }

  // Build conversation summary for agent transfer context
  const recentHistory = context.conversationHistory.slice(-5);
  sessionAttributes.conversationSummary = recentHistory
    .map(msg => `${msg.role === 'user' ? 'Patient' : 'Bot'}: ${msg.content}`)
    .join('\n');

  if (nextAction === 'continue') {
    // Continue conversation - elicit more input using ElicitIntent
    return {
      sessionState: {
        sessionAttributes,
        dialogAction: {
          type: 'ElicitIntent',
        },
      },
      messages: [
        {
          contentType: 'PlainText',
          content: message,
        },
      ],
    };
  }

  // End conversation (completed, send_sms, or end_call)
  return {
    sessionState: {
      sessionAttributes,
      dialogAction: {
        type: 'Close',
      },
      intent: {
        ...event.sessionState.intent,
        state: 'Fulfilled',
      },
    },
    messages: [
      {
        contentType: 'PlainText',
        content: message,
      },
    ],
  };
}

/**
 * Build transfer to agent response
 */
function buildTransferResponse(
  event: LexEvent,
  context: ConversationContext,
  message: string,
  reason?: string
): any {
  const sessionAttributes = event.sessionState.sessionAttributes || {};

  // Set session attributes for Connect flow
  sessionAttributes.nextAction = 'transfer_to_agent';
  sessionAttributes.assistantResponse = message;
  sessionAttributes.transferReason = reason || 'customer_request';

  // Build readable conversation summary for agent
  const recentHistory = context.conversationHistory.slice(-5);
  sessionAttributes.conversationSummary = recentHistory
    .map(msg => `${msg.role === 'user' ? 'Patient' : 'Bot'}: ${msg.content}`)
    .join('\n');

  sessionAttributes.patientId = context.patientId || '';
  sessionAttributes.patientName = context.patientName || '';

  return {
    sessionState: {
      sessionAttributes,
      dialogAction: {
        type: 'Close',
      },
      intent: {
        ...event.sessionState.intent,
        state: 'Fulfilled',
      },
    },
    messages: [
      {
        contentType: 'PlainText',
        content: message,
      },
    ],
    // Signal to Connect to transfer
    requestAttributes: {
      'x-amz-lex:transfer-to-agent': 'true',
    },
  };
}

/**
 * Build error response
 */
function buildErrorResponse(event: LexEvent, message: string): any {
  return {
    sessionState: {
      sessionAttributes: event.sessionState.sessionAttributes,
      dialogAction: {
        type: 'ElicitIntent',
      },
    },
    messages: [
      {
        contentType: 'PlainText',
        content: message,
      },
    ],
  };
}

// Helper functions
async function invokeFunction(functionArn: string, payload: any): Promise<any> {
  const command = new InvokeCommand({
    FunctionName: functionArn,
    Payload: JSON.stringify(payload),
  });
  const response = await lambdaClient.send(command);
  return JSON.parse(new TextDecoder().decode(response.Payload));
}

async function resolvePatientIdentity(phoneNumber: string): Promise<any> {
  try {
    return await invokeFunction(IDENTITY_RESOLVER_ARN, {
      action: 'resolveByPhone',
      phoneNumber,
      createIfNotFound: false,
    });
  } catch (error) {
    console.error('Error resolving identity:', error);
    return null;
  }
}

async function getUpcomingAppointments(patientId: string): Promise<any[]> {
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: APPOINTMENT_TABLE,
      IndexName: 'patient-index',
      KeyConditionExpression: 'patientId = :patientId',
      FilterExpression: 'appointmentDateTime >= :now',
      ExpressionAttributeValues: {
        ':patientId': patientId,
        ':now': new Date().toISOString(),
      },
      Limit: 5,
    }));
    return result.Items || [];
  } catch (error) {
    console.error('Error fetching appointments:', error);
    return [];
  }
}

async function recordConversation(
  patientId: string,
  direction: string,
  content: string,
  messageType: string
): Promise<void> {
  try {
    await docClient.send(new PutCommand({
      TableName: CONVERSATION_TABLE,
      Item: {
        patientId,
        messageTimestamp: new Date().toISOString(),
        messageId: randomUUID(),
        direction,
        content,
        messageType,
        channel: 'voice',
      },
    }));
  } catch (error) {
    console.error('Error recording conversation:', error);
  }
}
