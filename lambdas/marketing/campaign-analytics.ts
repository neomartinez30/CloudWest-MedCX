import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridge = new EventBridgeClient({});

const CAMPAIGN_TABLE = process.env.CAMPAIGN_TABLE!;
const OUTREACH_LOG_TABLE = process.env.OUTREACH_LOG_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface CampaignMetrics {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  converted: number;
  unsubscribed: number;
  bounced: number;
  failed: number;
}

/**
 * Campaign Analytics Lambda
 *
 * Tracks and analyzes campaign performance:
 * - Record delivery events
 * - Track opens and clicks
 * - Calculate conversion rates
 * - Generate reports
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Campaign Analytics Event:', JSON.stringify(event, null, 2));

  try {
    // Handle EventBridge events
    if (event.source?.startsWith('medcx')) {
      return handleEventBridgeEvent(event);
    }

    const { action, ...data } = event;

    switch (action) {
      case 'recordEvent':
        return recordEvent(data);

      case 'getCampaignAnalytics':
        return getCampaignAnalytics(data.campaignId);

      case 'getPerformanceReport':
        return getPerformanceReport(data);

      case 'comparePerformance':
        return comparePerformance(data.campaignIds);

      case 'recalculateMetrics':
        return recalculateMetrics(data.campaignId);

      case 'getTopPerforming':
        return getTopPerforming(data);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in campaign analytics:', error);
    return {
      error: 'Analytics failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Handle EventBridge events
 */
async function handleEventBridgeEvent(event: any): Promise<any> {
  const { detail, 'detail-type': detailType } = event;

  switch (detailType) {
    case 'MessageDelivered':
      return recordEvent({
        campaignId: detail.campaignId,
        eventType: 'delivered',
        outreachId: detail.outreachId,
      });

    case 'MessageOpened':
      return recordEvent({
        campaignId: detail.campaignId,
        eventType: 'opened',
        outreachId: detail.outreachId,
      });

    case 'MessageClicked':
      return recordEvent({
        campaignId: detail.campaignId,
        eventType: 'clicked',
        outreachId: detail.outreachId,
        metadata: { url: detail.url },
      });

    case 'Conversion':
      return recordEvent({
        campaignId: detail.campaignId,
        eventType: 'converted',
        outreachId: detail.outreachId,
        metadata: detail.metadata,
      });

    case 'Unsubscribed':
      return recordEvent({
        campaignId: detail.campaignId,
        eventType: 'unsubscribed',
        outreachId: detail.outreachId,
      });

    case 'MessageBounced':
      return recordEvent({
        campaignId: detail.campaignId,
        eventType: 'bounced',
        outreachId: detail.outreachId,
      });

    default:
      return { handled: false };
  }
}

/**
 * Record analytics event
 */
async function recordEvent(data: {
  campaignId: string;
  eventType: string;
  outreachId?: string;
  patientId?: string;
  metadata?: any;
}): Promise<any> {
  const { campaignId, eventType, outreachId, metadata } = data;

  if (!campaignId) {
    return { error: 'Campaign ID required' };
  }

  // Update outreach log if outreachId provided
  if (outreachId) {
    await docClient.send(new UpdateCommand({
      TableName: OUTREACH_LOG_TABLE,
      Key: { outreachId },
      UpdateExpression: 'SET #events = list_append(if_not_exists(#events, :empty), :event)',
      ExpressionAttributeNames: { '#events': 'events' },
      ExpressionAttributeValues: {
        ':empty': [],
        ':event': [{
          type: eventType,
          timestamp: new Date().toISOString(),
          metadata,
        }],
      },
    }));
  }

  // Update campaign metrics
  const metricField = getMetricField(eventType);
  if (metricField) {
    await docClient.send(new UpdateCommand({
      TableName: CAMPAIGN_TABLE,
      Key: { campaignId },
      UpdateExpression: `SET metrics.${metricField} = if_not_exists(metrics.${metricField}, :zero) + :one`,
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
      },
    }));
  }

  return { success: true, eventType };
}

/**
 * Get campaign analytics
 */
async function getCampaignAnalytics(campaignId: string): Promise<any> {
  const campaignResult = await docClient.send(new GetCommand({
    TableName: CAMPAIGN_TABLE,
    Key: { campaignId },
  }));

  const campaign = campaignResult.Item;
  if (!campaign) {
    return { error: 'Campaign not found' };
  }

  const metrics = campaign.metrics || {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    converted: 0,
    unsubscribed: 0,
    bounced: 0,
    failed: 0,
  };

  // Calculate rates
  const rates = calculateRates(metrics);

  // Get timeline data
  const timeline = await getTimelineData(campaignId);

  return {
    campaignId,
    name: campaign.name,
    status: campaign.status,
    campaignType: campaign.campaignType,
    metrics,
    rates,
    timeline,
    createdAt: campaign.createdAt,
    lastUpdated: campaign.updatedAt,
  };
}

/**
 * Get performance report
 */
async function getPerformanceReport(params: {
  startDate: string;
  endDate: string;
  campaignType?: string;
}): Promise<any> {
  const { startDate, endDate, campaignType } = params;

  let filterExpression = 'createdAt BETWEEN :start AND :end';
  const expressionValues: any = {
    ':start': startDate,
    ':end': endDate,
  };

  if (campaignType) {
    filterExpression += ' AND campaignType = :type';
    expressionValues[':type'] = campaignType;
  }

  const result = await docClient.send(new ScanCommand({
    TableName: CAMPAIGN_TABLE,
    FilterExpression: filterExpression,
    ExpressionAttributeValues: expressionValues,
  }));

  const campaigns = result.Items || [];

  // Aggregate metrics
  const totalMetrics: CampaignMetrics = {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    converted: 0,
    unsubscribed: 0,
    bounced: 0,
    failed: 0,
  };

  for (const campaign of campaigns) {
    const metrics = campaign.metrics || {};
    for (const key of Object.keys(totalMetrics) as (keyof CampaignMetrics)[]) {
      totalMetrics[key] += metrics[key] || 0;
    }
  }

  // By campaign type
  const byType: Record<string, CampaignMetrics> = {};
  for (const campaign of campaigns) {
    const type = campaign.campaignType || 'unknown';
    if (!byType[type]) {
      byType[type] = { sent: 0, delivered: 0, opened: 0, clicked: 0, converted: 0, unsubscribed: 0, bounced: 0, failed: 0 };
    }
    const metrics = campaign.metrics || {};
    for (const key of Object.keys(byType[type]) as (keyof CampaignMetrics)[]) {
      byType[type][key] += metrics[key] || 0;
    }
  }

  return {
    dateRange: { startDate, endDate },
    campaignCount: campaigns.length,
    totalMetrics,
    rates: calculateRates(totalMetrics),
    byType: Object.entries(byType).map(([type, metrics]) => ({
      type,
      metrics,
      rates: calculateRates(metrics),
    })),
    topCampaigns: campaigns
      .sort((a, b) => (b.metrics?.converted || 0) - (a.metrics?.converted || 0))
      .slice(0, 5)
      .map(c => ({
        campaignId: c.campaignId,
        name: c.name,
        metrics: c.metrics,
        rates: calculateRates(c.metrics || {}),
      })),
  };
}

/**
 * Compare campaign performance
 */
async function comparePerformance(campaignIds: string[]): Promise<any> {
  const campaigns = await Promise.all(
    campaignIds.map(async (id) => {
      const result = await docClient.send(new GetCommand({
        TableName: CAMPAIGN_TABLE,
        Key: { campaignId: id },
      }));
      return result.Item;
    })
  );

  const comparison = campaigns.filter(Boolean).map(campaign => ({
    campaignId: campaign!.campaignId,
    name: campaign!.name,
    campaignType: campaign!.campaignType,
    metrics: campaign!.metrics || {},
    rates: calculateRates(campaign!.metrics || {}),
  }));

  // Calculate averages
  const avgMetrics: CampaignMetrics = {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    converted: 0,
    unsubscribed: 0,
    bounced: 0,
    failed: 0,
  };

  for (const c of comparison) {
    for (const key of Object.keys(avgMetrics) as (keyof CampaignMetrics)[]) {
      avgMetrics[key] += c.metrics[key] || 0;
    }
  }

  const count = comparison.length;
  for (const key of Object.keys(avgMetrics) as (keyof CampaignMetrics)[]) {
    avgMetrics[key] = Math.round(avgMetrics[key] / count);
  }

  return {
    campaigns: comparison,
    averages: {
      metrics: avgMetrics,
      rates: calculateRates(avgMetrics),
    },
    winner: comparison.reduce((best, current) =>
      (parseFloat(current.rates.conversionRate) > parseFloat(best.rates.conversionRate)) ? current : best
    ),
  };
}

/**
 * Recalculate campaign metrics from log
 */
async function recalculateMetrics(campaignId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: OUTREACH_LOG_TABLE,
    IndexName: 'campaign-index',
    KeyConditionExpression: 'campaignId = :campaignId',
    ExpressionAttributeValues: { ':campaignId': campaignId },
  }));

  const outreachLogs = result.Items || [];

  const metrics: CampaignMetrics = {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    converted: 0,
    unsubscribed: 0,
    bounced: 0,
    failed: 0,
  };

  for (const log of outreachLogs) {
    if (log.status === 'sent') metrics.sent++;
    if (log.status === 'failed') metrics.failed++;

    const events = log.events || [];
    for (const event of events) {
      const field = getMetricField(event.type);
      if (field && field in metrics) {
        metrics[field as keyof CampaignMetrics]++;
      }
    }
  }

  // Update campaign
  await docClient.send(new UpdateCommand({
    TableName: CAMPAIGN_TABLE,
    Key: { campaignId },
    UpdateExpression: 'SET metrics = :metrics, updatedAt = :updated',
    ExpressionAttributeValues: {
      ':metrics': metrics,
      ':updated': new Date().toISOString(),
    },
  }));

  return {
    success: true,
    campaignId,
    metrics,
    rates: calculateRates(metrics),
  };
}

/**
 * Get top performing campaigns
 */
async function getTopPerforming(params: {
  metric?: string;
  limit?: number;
  campaignType?: string;
}): Promise<any> {
  const { metric = 'conversionRate', limit = 10, campaignType } = params;

  let filterExpression: string | undefined;
  const expressionValues: any = {};
  const expressionNames: any = { '#status': 'status' };

  filterExpression = '#status = :completed';
  expressionValues[':completed'] = 'completed';

  if (campaignType) {
    filterExpression += ' AND campaignType = :type';
    expressionValues[':type'] = campaignType;
  }

  const result = await docClient.send(new ScanCommand({
    TableName: CAMPAIGN_TABLE,
    FilterExpression: filterExpression,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
  }));

  const campaigns = (result.Items || [])
    .map(c => ({
      ...c,
      rates: calculateRates(c.metrics || {}),
    }))
    .sort((a, b) => {
      const rateA = parseFloat(a.rates[metric] || '0');
      const rateB = parseFloat(b.rates[metric] || '0');
      return rateB - rateA;
    })
    .slice(0, limit);

  return {
    metric,
    campaigns: campaigns.map(c => ({
      campaignId: c.campaignId,
      name: c.name,
      campaignType: c.campaignType,
      metrics: c.metrics,
      rates: c.rates,
    })),
  };
}

// Helper functions
function getMetricField(eventType: string): string | null {
  const mapping: Record<string, string> = {
    delivered: 'delivered',
    opened: 'opened',
    clicked: 'clicked',
    converted: 'converted',
    unsubscribed: 'unsubscribed',
    bounced: 'bounced',
    failed: 'failed',
  };
  return mapping[eventType] || null;
}

function calculateRates(metrics: Partial<CampaignMetrics>): Record<string, string> {
  const sent = metrics.sent || 0;
  const delivered = metrics.delivered || 0;
  const opened = metrics.opened || 0;
  const clicked = metrics.clicked || 0;
  const converted = metrics.converted || 0;

  return {
    deliveryRate: sent > 0 ? ((delivered / sent) * 100).toFixed(1) : '0',
    openRate: delivered > 0 ? ((opened / delivered) * 100).toFixed(1) : '0',
    clickRate: opened > 0 ? ((clicked / opened) * 100).toFixed(1) : '0',
    conversionRate: clicked > 0 ? ((converted / clicked) * 100).toFixed(1) : '0',
    bounceRate: sent > 0 ? (((metrics.bounced || 0) / sent) * 100).toFixed(1) : '0',
    unsubscribeRate: sent > 0 ? (((metrics.unsubscribed || 0) / sent) * 100).toFixed(1) : '0',
  };
}

async function getTimelineData(campaignId: string): Promise<any[]> {
  // In production, would aggregate events by time
  return [];
}
