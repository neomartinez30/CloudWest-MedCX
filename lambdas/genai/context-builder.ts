import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;

interface PatientContext {
  patientId: string;
  profile: {
    name: string;
    dateOfBirth?: string;
    phoneNumber?: string;
    email?: string;
    preferredChannel?: string;
    preferredLanguage?: string;
  };
  appointments: {
    upcoming: any[];
    past: any[];
    nextAppointment?: any;
  };
  conversations: {
    recentMessages: any[];
    activeChannels: string[];
    lastInteraction?: string;
  };
  preferences: {
    appointmentReminders: boolean;
    communicationPreferences: string[];
    specialInstructions?: string;
  };
  insuranceInfo?: {
    provider?: string;
    memberId?: string;
    verified?: boolean;
  };
}

/**
 * Context Builder Lambda
 *
 * Builds comprehensive patient context for AI conversations:
 * - Aggregates patient profile data
 * - Fetches conversation history
 * - Retrieves appointment information
 * - Compiles preferences and insurance info
 * - Formats context for Bedrock/Claude consumption
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Context Builder Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...data } = event;

    switch (action) {
      case 'buildFullContext':
        return buildFullContext(data.patientId, data.options);

      case 'buildConversationContext':
        return buildConversationContext(data.patientId, data.channel);

      case 'buildAppointmentContext':
        return buildAppointmentContext(data.patientId);

      case 'formatForBedrock':
        return formatContextForBedrock(data.context, data.intent);

      case 'summarizeContext':
        return summarizeContext(data.patientId);

      default:
        // Default to building full context
        return buildFullContext(data.patientId);
    }
  } catch (error) {
    console.error('Error building context:', error);
    return {
      error: 'Failed to build context',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Build full patient context
 */
async function buildFullContext(
  patientId: string,
  options?: { includeHistory?: boolean; maxMessages?: number }
): Promise<PatientContext> {
  const [profile, appointments, conversations, interactions] = await Promise.all([
    getPatientProfile(patientId),
    getPatientAppointments(patientId),
    getConversationHistory(patientId, options?.maxMessages || 10),
    getRecentInteractions(patientId),
  ]);

  const activeChannels = [...new Set(interactions.map((i: any) => i.channel).filter(Boolean))];

  return {
    patientId,
    profile: {
      name: `${profile?.firstName || ''} ${profile?.lastName || ''}`.trim() || 'Unknown',
      dateOfBirth: profile?.dateOfBirth,
      phoneNumber: profile?.phoneNumber,
      email: profile?.email,
      preferredChannel: profile?.preferredChannel || 'sms',
      preferredLanguage: profile?.preferredLanguage || 'en',
    },
    appointments: {
      upcoming: appointments.filter((a: any) => new Date(a.appointmentDate) >= new Date()),
      past: appointments.filter((a: any) => new Date(a.appointmentDate) < new Date()).slice(0, 5),
      nextAppointment: appointments.find((a: any) =>
        new Date(a.appointmentDate) >= new Date() && a.status === 'scheduled'
      ),
    },
    conversations: {
      recentMessages: conversations,
      activeChannels,
      lastInteraction: interactions[0]?.interactionTimestamp,
    },
    preferences: {
      appointmentReminders: profile?.appointmentReminders !== false,
      communicationPreferences: profile?.communicationPreferences || ['sms'],
      specialInstructions: profile?.specialInstructions,
    },
    insuranceInfo: profile?.insurance ? {
      provider: profile.insurance.provider,
      memberId: profile.insurance.memberId,
      verified: profile.insurance.verified,
    } : undefined,
  };
}

/**
 * Build conversation-focused context
 */
async function buildConversationContext(patientId: string, channel?: string): Promise<any> {
  const [profile, conversations] = await Promise.all([
    getPatientProfile(patientId),
    getConversationHistory(patientId, 20, channel),
  ]);

  return {
    patientId,
    patientName: `${profile?.firstName || ''} ${profile?.lastName || ''}`.trim(),
    preferredChannel: profile?.preferredChannel || 'sms',
    currentChannel: channel,
    conversationHistory: conversations.map((msg: any) => ({
      role: msg.direction === 'INBOUND' ? 'user' : 'assistant',
      content: msg.content,
      timestamp: msg.messageTimestamp,
      channel: msg.channel,
    })),
    lastMessage: conversations[0],
  };
}

/**
 * Build appointment-focused context
 */
async function buildAppointmentContext(patientId: string): Promise<any> {
  const [profile, appointments] = await Promise.all([
    getPatientProfile(patientId),
    getPatientAppointments(patientId),
  ]);

  const now = new Date();
  const upcoming = appointments
    .filter((a: any) => new Date(a.appointmentDate) >= now)
    .sort((a: any, b: any) => new Date(a.appointmentDate).getTime() - new Date(b.appointmentDate).getTime());

  const past = appointments
    .filter((a: any) => new Date(a.appointmentDate) < now)
    .sort((a: any, b: any) => new Date(b.appointmentDate).getTime() - new Date(a.appointmentDate).getTime())
    .slice(0, 5);

  return {
    patientId,
    patientName: `${profile?.firstName || ''} ${profile?.lastName || ''}`.trim(),
    upcomingAppointments: upcoming,
    pastAppointments: past,
    nextAppointment: upcoming[0],
    hasUpcoming: upcoming.length > 0,
    preferredProvider: profile?.preferredProvider,
    preferredLocation: profile?.preferredLocation,
    appointmentPreferences: {
      preferredDays: profile?.preferredDays || [],
      preferredTimes: profile?.preferredTimes || [],
      needsTransportation: profile?.needsTransportation || false,
    },
  };
}

/**
 * Format context for Bedrock consumption
 */
function formatContextForBedrock(context: PatientContext, intent?: string): string {
  let formattedContext = `## Patient Information
- Name: ${context.profile.name}
- Phone: ${context.profile.phoneNumber || 'Not provided'}
- Preferred Channel: ${context.profile.preferredChannel}
- Language: ${context.profile.preferredLanguage}

`;

  if (context.appointments.nextAppointment) {
    const apt = context.appointments.nextAppointment;
    formattedContext += `## Next Appointment
- Date: ${apt.appointmentDate}
- Time: ${apt.appointmentTime}
- Provider: ${apt.providerName || 'TBD'}
- Type: ${apt.appointmentType || 'General'}
- Location: ${apt.location || 'Main Office'}

`;
  }

  if (context.appointments.upcoming.length > 0) {
    formattedContext += `## Upcoming Appointments (${context.appointments.upcoming.length} total)
${context.appointments.upcoming.slice(0, 3).map((apt: any) =>
  `- ${apt.appointmentDate} at ${apt.appointmentTime}: ${apt.appointmentType || 'Appointment'}`
).join('\n')}

`;
  }

  if (context.conversations.recentMessages.length > 0) {
    formattedContext += `## Recent Conversation
${context.conversations.recentMessages.slice(0, 5).map((msg: any) =>
  `[${msg.direction === 'INBOUND' ? 'Patient' : 'System'}]: ${msg.content}`
).join('\n')}

`;
  }

  if (context.insuranceInfo?.provider) {
    formattedContext += `## Insurance
- Provider: ${context.insuranceInfo.provider}
- Status: ${context.insuranceInfo.verified ? 'Verified' : 'Pending verification'}

`;
  }

  if (intent) {
    formattedContext += `## Current Intent
The patient appears to be asking about: ${intent}

`;
  }

  formattedContext += `## Preferences
- Appointment Reminders: ${context.preferences.appointmentReminders ? 'Yes' : 'No'}
- Communication Channels: ${context.preferences.communicationPreferences.join(', ')}
${context.preferences.specialInstructions ? `- Special Instructions: ${context.preferences.specialInstructions}` : ''}
`;

  return formattedContext;
}

/**
 * Create summarized context for quick reference
 */
async function summarizeContext(patientId: string): Promise<any> {
  const context = await buildFullContext(patientId, { maxMessages: 5 });

  return {
    patientId,
    summary: {
      name: context.profile.name,
      hasUpcomingAppointment: context.appointments.upcoming.length > 0,
      nextAppointmentDate: context.appointments.nextAppointment?.appointmentDate,
      lastContactDate: context.conversations.lastInteraction,
      preferredChannel: context.profile.preferredChannel,
      activeChannels: context.conversations.activeChannels,
      insuranceVerified: context.insuranceInfo?.verified || false,
    },
    quickFacts: buildQuickFacts(context),
  };
}

/**
 * Build quick facts for agent display
 */
function buildQuickFacts(context: PatientContext): string[] {
  const facts: string[] = [];

  if (context.appointments.nextAppointment) {
    const apt = context.appointments.nextAppointment;
    facts.push(`Next appointment: ${apt.appointmentDate} at ${apt.appointmentTime}`);
  } else {
    facts.push('No upcoming appointments scheduled');
  }

  if (context.conversations.lastInteraction) {
    const lastContact = new Date(context.conversations.lastInteraction);
    const daysSince = Math.floor((Date.now() - lastContact.getTime()) / (1000 * 60 * 60 * 24));
    facts.push(`Last contact: ${daysSince} days ago`);
  }

  if (context.profile.preferredChannel) {
    facts.push(`Prefers: ${context.profile.preferredChannel}`);
  }

  if (context.insuranceInfo?.provider) {
    facts.push(`Insurance: ${context.insuranceInfo.provider}`);
  }

  if (context.preferences.specialInstructions) {
    facts.push(`Note: ${context.preferences.specialInstructions}`);
  }

  return facts;
}

// Data fetching helpers
async function getPatientProfile(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));
  return result.Item;
}

async function getPatientAppointments(patientId: string): Promise<any[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: true,
  }));
  return result.Items || [];
}

async function getConversationHistory(
  patientId: string,
  limit: number = 10,
  channel?: string
): Promise<any[]> {
  const params: any = {
    TableName: CONVERSATION_TABLE,
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
    Limit: limit,
  };

  if (channel) {
    params.FilterExpression = 'channel = :channel';
    params.ExpressionAttributeValues[':channel'] = channel;
  }

  const result = await docClient.send(new QueryCommand(params));
  return result.Items || [];
}

async function getRecentInteractions(patientId: string): Promise<any[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: INTERACTION_TABLE,
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
    Limit: 20,
  }));
  return result.Items || [];
}
