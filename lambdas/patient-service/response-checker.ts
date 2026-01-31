import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;

/**
 * Response check input from Step Functions
 */
interface ResponseCheckInput {
  patientId: string;
  messageId?: string;
  threadId?: string;
  followupType: string;
  sentAt: string;
  retryCount: number;
}

/**
 * Response check result for Step Functions
 */
interface ResponseCheckResult {
  responded: boolean;
  patientId: string;
  responseType?: string;
  responseContent?: string;
  responseTimestamp?: string;
  retryCount: number;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'urgent';
  needsEscalation: boolean;
  escalationReason?: string;
}

/**
 * Response Checker Lambda Handler
 *
 * This function checks if a patient has responded to a follow-up message.
 * It's used by the Care Follow-up State Machine to determine next steps:
 * - If responded: Complete the follow-up workflow
 * - If not responded: Retry or escalate based on retry count
 *
 * It also analyzes the response sentiment to determine if escalation is needed.
 */
export const handler = async (event: any): Promise<ResponseCheckResult> => {
  console.log('Response Checker Event:', JSON.stringify(event, null, 2));

  try {
    // Parse input from Step Functions
    const input: ResponseCheckInput = event.Payload || event;
    const {
      patientId,
      messageId,
      threadId,
      followupType,
      sentAt,
      retryCount,
    } = input;

    // Query for patient responses after the followup was sent
    const responses = await getPatientResponses(patientId, sentAt, threadId);

    if (responses.length === 0) {
      // No response found
      return {
        responded: false,
        patientId,
        retryCount,
        needsEscalation: retryCount >= 2, // Escalate after 3 attempts
        escalationReason: retryCount >= 2 ? 'No response after multiple attempts' : undefined,
      };
    }

    // Analyze the most recent response
    const latestResponse = responses[0];
    const analysis = analyzeResponse(latestResponse.content, followupType);

    return {
      responded: true,
      patientId,
      responseType: latestResponse.messageType,
      responseContent: latestResponse.content,
      responseTimestamp: latestResponse.messageTimestamp,
      retryCount,
      sentiment: analysis.sentiment,
      needsEscalation: analysis.needsEscalation,
      escalationReason: analysis.escalationReason,
    };
  } catch (error) {
    console.error('Error checking response:', error);

    const input: ResponseCheckInput = event.Payload || event;
    return {
      responded: false,
      patientId: input.patientId,
      retryCount: input.retryCount,
      needsEscalation: true,
      escalationReason: `Error checking response: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
};

/**
 * Get patient responses from conversation table
 */
async function getPatientResponses(
  patientId: string,
  sentAfter: string,
  threadId?: string
): Promise<any[]> {
  // Query for inbound messages from the patient after the followup was sent
  const result = await docClient.send(new QueryCommand({
    TableName: CONVERSATION_TABLE,
    KeyConditionExpression: 'patientId = :patientId AND messageTimestamp > :sentAfter',
    FilterExpression: 'direction = :direction',
    ExpressionAttributeValues: {
      ':patientId': patientId,
      ':sentAfter': sentAfter,
      ':direction': 'INBOUND',
    },
    ScanIndexForward: false, // Most recent first
    Limit: 10,
  }));

  // If threadId provided, filter to that thread
  let responses = result.Items || [];
  if (threadId) {
    responses = responses.filter(r => r.threadId === threadId);
  }

  return responses;
}

/**
 * Analyze response content for sentiment and escalation needs
 */
function analyzeResponse(
  content: string,
  followupType: string
): { sentiment: 'positive' | 'neutral' | 'negative' | 'urgent'; needsEscalation: boolean; escalationReason?: string } {
  const lowerContent = content?.toLowerCase() || '';

  // Check for urgent keywords first
  const urgentKeywords = [
    'emergency', 'urgent', 'help', 'worse', 'pain', 'bleeding',
    'cant breathe', 'chest pain', 'fell', 'accident', '911',
  ];

  for (const keyword of urgentKeywords) {
    if (lowerContent.includes(keyword)) {
      return {
        sentiment: 'urgent',
        needsEscalation: true,
        escalationReason: `Urgent keyword detected: ${keyword}`,
      };
    }
  }

  // Check for numeric responses (common for surveys)
  const numericMatch = lowerContent.match(/^[1-5]$/);
  if (numericMatch) {
    const rating = parseInt(numericMatch[0]);

    // For satisfaction surveys
    if (followupType === 'SATISFACTION_SURVEY') {
      if (rating <= 2) {
        return {
          sentiment: 'negative',
          needsEscalation: true,
          escalationReason: 'Low satisfaction score',
        };
      }
      return {
        sentiment: rating >= 4 ? 'positive' : 'neutral',
        needsEscalation: false,
      };
    }

    // For health check-ins
    if (followupType === 'CARE_CHECK_IN' || followupType === 'POST_APPOINTMENT') {
      if (rating >= 4) { // 4 = Worse, 5 = Need Help
        return {
          sentiment: 'negative',
          needsEscalation: true,
          escalationReason: 'Patient reported feeling worse or needing help',
        };
      }
      return {
        sentiment: rating <= 2 ? 'positive' : 'neutral',
        needsEscalation: false,
      };
    }
  }

  // Check for confirmation responses
  const confirmKeywords = ['yes', 'confirm', 'ok', 'okay', 'sure', 'great', 'good', 'thanks'];
  for (const keyword of confirmKeywords) {
    if (lowerContent.includes(keyword)) {
      return {
        sentiment: 'positive',
        needsEscalation: false,
      };
    }
  }

  // Check for cancellation or rescheduling
  if (lowerContent.includes('cancel')) {
    return {
      sentiment: 'neutral',
      needsEscalation: true,
      escalationReason: 'Patient requested cancellation',
    };
  }

  if (lowerContent.includes('reschedule')) {
    return {
      sentiment: 'neutral',
      needsEscalation: true,
      escalationReason: 'Patient requested rescheduling',
    };
  }

  // Check for negative sentiment
  const negativeKeywords = ['no', 'bad', 'terrible', 'awful', 'disappointed', 'unhappy', 'angry'];
  for (const keyword of negativeKeywords) {
    if (lowerContent.includes(keyword)) {
      return {
        sentiment: 'negative',
        needsEscalation: followupType === 'SATISFACTION_SURVEY' || followupType === 'CARE_CHECK_IN',
        escalationReason: followupType === 'SATISFACTION_SURVEY'
          ? 'Negative feedback received'
          : 'Patient expressed negative sentiment',
      };
    }
  }

  // Check for payment responses
  if (followupType === 'PAYMENT_REMINDER') {
    if (lowerContent.includes('pay')) {
      return {
        sentiment: 'positive',
        needsEscalation: false,
      };
    }
    if (lowerContent.includes('help') || lowerContent.includes('hardship') || lowerContent.includes('cant pay')) {
      return {
        sentiment: 'negative',
        needsEscalation: true,
        escalationReason: 'Patient needs payment assistance',
      };
    }
  }

  // Check for prescription responses
  if (followupType === 'PRESCRIPTION_REMINDER') {
    if (lowerContent.includes('refill')) {
      return {
        sentiment: 'neutral',
        needsEscalation: true,
        escalationReason: 'Patient requested prescription refill',
      };
    }
  }

  // Default to neutral with no escalation
  return {
    sentiment: 'neutral',
    needsEscalation: false,
  };
}
