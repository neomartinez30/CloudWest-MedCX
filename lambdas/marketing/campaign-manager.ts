import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import { v4 as uuidv4 } from 'uuid';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});
const eventBridge = new EventBridgeClient({});
const schedulerClient = new SchedulerClient({});

const CAMPAIGN_TABLE = process.env.CAMPAIGN_TABLE!;
const SEGMENT_TABLE = process.env.SEGMENT_TABLE!;
const OUTREACH_SENDER_ARN = process.env.OUTREACH_SENDER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;

type CampaignType = 'appointment_reminder' | 'wellness_check' | 'reactivation' | 'promotion' | 'survey' | 'custom';
type CampaignStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'cancelled';

interface Campaign {
  campaignId: string;
  name: string;
  campaignType: CampaignType;
  status: CampaignStatus;
  segmentId: string;
  message: {
    template: string;
    subject?: string;
    variables?: Record<string, string>;
  };
  channels: string[];
  schedule?: {
    startDate: string;
    endDate?: string;
    frequency?: 'once' | 'daily' | 'weekly' | 'monthly';
    sendTime?: string;
  };
  metrics?: {
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    converted: number;
    unsubscribed: number;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * Campaign Manager Lambda
 *
 * Manages marketing campaigns and outreach:
 * - Create and manage campaigns
 * - Schedule campaign execution
 * - Track campaign performance
 * - A/B testing support
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Campaign Manager Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...data } = event;

    switch (action) {
      case 'createCampaign':
        return createCampaign(data);

      case 'updateCampaign':
        return updateCampaign(data);

      case 'getCampaign':
        return getCampaign(data.campaignId);

      case 'listCampaigns':
        return listCampaigns(data);

      case 'startCampaign':
        return startCampaign(data.campaignId);

      case 'pauseCampaign':
        return pauseCampaign(data.campaignId);

      case 'cancelCampaign':
        return cancelCampaign(data.campaignId);

      case 'executeCampaign':
        return executeCampaign(data.campaignId);

      case 'getCampaignMetrics':
        return getCampaignMetrics(data.campaignId);

      case 'cloneCampaign':
        return cloneCampaign(data.campaignId, data.newName);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in campaign manager:', error);
    return {
      error: 'Campaign operation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Create a new campaign
 */
async function createCampaign(data: Partial<Campaign>): Promise<any> {
  const campaignId = uuidv4();
  const now = new Date().toISOString();

  const campaign: Campaign = {
    campaignId,
    name: data.name || 'Untitled Campaign',
    campaignType: data.campaignType || 'custom',
    status: 'draft',
    segmentId: data.segmentId || '',
    message: data.message || { template: '' },
    channels: data.channels || ['sms'],
    schedule: data.schedule,
    metrics: {
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      converted: 0,
      unsubscribed: 0,
    },
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: CAMPAIGN_TABLE,
    Item: campaign,
  }));

  await emitEvent('CampaignCreated', {
    campaignId,
    name: campaign.name,
    type: campaign.campaignType,
    timestamp: now,
  });

  return {
    success: true,
    campaignId,
    campaign,
  };
}

/**
 * Update campaign
 */
async function updateCampaign(data: { campaignId: string } & Partial<Campaign>): Promise<any> {
  const { campaignId, ...updates } = data;
  const now = new Date().toISOString();

  // Build update expression
  const updateParts: string[] = ['updatedAt = :updated'];
  const expressionValues: any = { ':updated': now };
  const expressionNames: any = {};

  for (const [key, value] of Object.entries(updates)) {
    if (key !== 'campaignId' && value !== undefined) {
      const attrName = `#${key}`;
      const attrValue = `:${key}`;
      expressionNames[attrName] = key;
      expressionValues[attrValue] = value;
      updateParts.push(`${attrName} = ${attrValue}`);
    }
  }

  await docClient.send(new UpdateCommand({
    TableName: CAMPAIGN_TABLE,
    Key: { campaignId },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeNames: Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
    ExpressionAttributeValues: expressionValues,
  }));

  return {
    success: true,
    campaignId,
    updated: Object.keys(updates),
  };
}

/**
 * Get campaign
 */
async function getCampaign(campaignId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: CAMPAIGN_TABLE,
    Key: { campaignId },
  }));

  if (!result.Item) {
    return { error: 'Campaign not found' };
  }

  return result.Item;
}

/**
 * List campaigns
 */
async function listCampaigns(params: {
  status?: CampaignStatus;
  campaignType?: CampaignType;
  limit?: number;
}): Promise<any> {
  const { status, campaignType, limit = 50 } = params;

  let filterExpression: string | undefined;
  const expressionValues: any = {};
  const expressionNames: any = {};

  const filters: string[] = [];

  if (status) {
    filters.push('#status = :status');
    expressionNames['#status'] = 'status';
    expressionValues[':status'] = status;
  }

  if (campaignType) {
    filters.push('campaignType = :campaignType');
    expressionValues[':campaignType'] = campaignType;
  }

  if (filters.length > 0) {
    filterExpression = filters.join(' AND ');
  }

  const result = await docClient.send(new ScanCommand({
    TableName: CAMPAIGN_TABLE,
    FilterExpression: filterExpression,
    ExpressionAttributeNames: Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
    ExpressionAttributeValues: Object.keys(expressionValues).length > 0 ? expressionValues : undefined,
    Limit: limit,
  }));

  return {
    campaigns: result.Items || [],
    count: result.Items?.length || 0,
  };
}

/**
 * Start campaign
 */
async function startCampaign(campaignId: string): Promise<any> {
  const campaign = await getCampaign(campaignId);

  if (campaign.error) {
    return campaign;
  }

  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    return { error: 'Campaign cannot be started in current status' };
  }

  const now = new Date().toISOString();

  // Schedule campaign if it has a schedule
  if (campaign.schedule?.startDate) {
    const scheduleName = `campaign-${campaignId}`;
    const scheduleTime = new Date(campaign.schedule.startDate);

    if (scheduleTime > new Date()) {
      // Future schedule
      await schedulerClient.send(new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: `at(${scheduleTime.toISOString()})`,
        Target: {
          Arn: OUTREACH_SENDER_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({
            action: 'executeCampaign',
            campaignId,
          }),
        },
        FlexibleTimeWindow: { Mode: 'OFF' },
      }));

      await updateCampaign({
        campaignId,
        status: 'scheduled',
      });

      return {
        success: true,
        campaignId,
        status: 'scheduled',
        scheduledFor: campaign.schedule.startDate,
      };
    }
  }

  // Execute immediately
  await updateCampaign({
    campaignId,
    status: 'active',
  });

  // Trigger execution
  await invokeFunction(OUTREACH_SENDER_ARN, {
    action: 'executeCampaign',
    campaignId,
  });

  await emitEvent('CampaignStarted', {
    campaignId,
    timestamp: now,
  });

  return {
    success: true,
    campaignId,
    status: 'active',
  };
}

/**
 * Pause campaign
 */
async function pauseCampaign(campaignId: string): Promise<any> {
  const campaign = await getCampaign(campaignId);

  if (campaign.error) {
    return campaign;
  }

  if (campaign.status !== 'active' && campaign.status !== 'scheduled') {
    return { error: 'Campaign cannot be paused in current status' };
  }

  // Delete scheduler if exists
  try {
    await schedulerClient.send(new DeleteScheduleCommand({
      Name: `campaign-${campaignId}`,
    }));
  } catch {
    // Schedule might not exist
  }

  await updateCampaign({
    campaignId,
    status: 'paused',
  });

  await emitEvent('CampaignPaused', {
    campaignId,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    campaignId,
    status: 'paused',
  };
}

/**
 * Cancel campaign
 */
async function cancelCampaign(campaignId: string): Promise<any> {
  const campaign = await getCampaign(campaignId);

  if (campaign.error) {
    return campaign;
  }

  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    return { error: 'Campaign already completed or cancelled' };
  }

  // Delete scheduler if exists
  try {
    await schedulerClient.send(new DeleteScheduleCommand({
      Name: `campaign-${campaignId}`,
    }));
  } catch {
    // Schedule might not exist
  }

  await updateCampaign({
    campaignId,
    status: 'cancelled',
  });

  await emitEvent('CampaignCancelled', {
    campaignId,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    campaignId,
    status: 'cancelled',
  };
}

/**
 * Execute campaign
 */
async function executeCampaign(campaignId: string): Promise<any> {
  const campaign = await getCampaign(campaignId);

  if (campaign.error) {
    return campaign;
  }

  // Get segment members
  const segmentResult = await docClient.send(new GetCommand({
    TableName: SEGMENT_TABLE,
    Key: { segmentId: campaign.segmentId },
  }));

  const segment = segmentResult.Item;
  if (!segment) {
    return { error: 'Segment not found' };
  }

  // Execute via outreach sender
  const result = await invokeFunction(OUTREACH_SENDER_ARN, {
    action: 'sendBulkOutreach',
    campaignId,
    segmentId: campaign.segmentId,
    message: campaign.message,
    channels: campaign.channels,
  });

  // Update metrics
  await updateCampaign({
    campaignId,
    status: 'completed',
    metrics: result.metrics,
  });

  await emitEvent('CampaignExecuted', {
    campaignId,
    sent: result.metrics?.sent || 0,
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    campaignId,
    executed: true,
    metrics: result.metrics,
  };
}

/**
 * Get campaign metrics
 */
async function getCampaignMetrics(campaignId: string): Promise<any> {
  const campaign = await getCampaign(campaignId);

  if (campaign.error) {
    return campaign;
  }

  const metrics = campaign.metrics || {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    converted: 0,
    unsubscribed: 0,
  };

  return {
    campaignId,
    name: campaign.name,
    status: campaign.status,
    metrics,
    rates: {
      deliveryRate: metrics.sent > 0 ? ((metrics.delivered / metrics.sent) * 100).toFixed(1) : 0,
      openRate: metrics.delivered > 0 ? ((metrics.opened / metrics.delivered) * 100).toFixed(1) : 0,
      clickRate: metrics.opened > 0 ? ((metrics.clicked / metrics.opened) * 100).toFixed(1) : 0,
      conversionRate: metrics.clicked > 0 ? ((metrics.converted / metrics.clicked) * 100).toFixed(1) : 0,
    },
  };
}

/**
 * Clone campaign
 */
async function cloneCampaign(campaignId: string, newName?: string): Promise<any> {
  const campaign = await getCampaign(campaignId);

  if (campaign.error) {
    return campaign;
  }

  return createCampaign({
    name: newName || `${campaign.name} (Copy)`,
    campaignType: campaign.campaignType,
    segmentId: campaign.segmentId,
    message: campaign.message,
    channels: campaign.channels,
    schedule: campaign.schedule,
  });
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

async function emitEvent(detailType: string, detail: Record<string, any>): Promise<void> {
  await eventBridge.send(new PutEventsCommand({
    Entries: [{
      EventBusName: EVENT_BUS_NAME,
      Source: 'medcx.campaigns',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
