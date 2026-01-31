import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const INTERACTION_TABLE = process.env.INTERACTION_TABLE!;
const CONVERSATION_TABLE = process.env.CONVERSATION_TABLE!;
const PAYMENT_TABLE = process.env.PAYMENT_TABLE!;
const CAMPAIGN_TABLE = process.env.CAMPAIGN_TABLE!;

interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Analytics Lambda
 *
 * Generates analytics and reports for the dashboard:
 * - Appointment metrics
 * - Channel usage statistics
 * - Payment analytics
 * - Campaign performance
 * - Trend analysis
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Analytics Event:', JSON.stringify(event, null, 2));

  try {
    const { action, ...params } = event;

    switch (action) {
      case 'getAppointmentMetrics':
        return getAppointmentMetrics(params);

      case 'getChannelMetrics':
        return getChannelMetrics(params);

      case 'getPaymentMetrics':
        return getPaymentMetrics(params);

      case 'getCampaignMetrics':
        return getCampaignMetrics(params);

      case 'getDashboardSummary':
        return getDashboardSummary(params);

      case 'getTrends':
        return getTrends(params);

      case 'getAgentPerformance':
        return getAgentPerformance(params);

      default:
        return getDashboardSummary(params);
    }
  } catch (error) {
    console.error('Error in analytics:', error);
    return {
      error: 'Analytics failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Get appointment metrics
 */
async function getAppointmentMetrics(params: DateRange & { groupBy?: string }): Promise<any> {
  const { startDate, endDate, groupBy = 'day' } = params;

  const result = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'date-index',
    KeyConditionExpression: 'appointmentDate BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':start': startDate,
      ':end': endDate,
    },
  }));

  const appointments = result.Items || [];

  // Calculate metrics
  const total = appointments.length;
  const scheduled = appointments.filter((a: any) => a.status === 'scheduled').length;
  const completed = appointments.filter((a: any) => a.status === 'completed').length;
  const cancelled = appointments.filter((a: any) => a.status === 'cancelled').length;
  const noShow = appointments.filter((a: any) => a.status === 'no_show').length;
  const rescheduled = appointments.filter((a: any) => a.status === 'rescheduled').length;

  // Group by date
  const byDate: Record<string, any> = {};
  for (const apt of appointments) {
    const date = apt.appointmentDate;
    if (!byDate[date]) {
      byDate[date] = { scheduled: 0, completed: 0, cancelled: 0, noShow: 0, total: 0 };
    }
    byDate[date].total++;
    byDate[date][apt.status] = (byDate[date][apt.status] || 0) + 1;
  }

  // By type
  const byType: Record<string, number> = {};
  for (const apt of appointments) {
    const type = apt.appointmentType || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }

  // By provider
  const byProvider: Record<string, number> = {};
  for (const apt of appointments) {
    const provider = apt.providerName || apt.providerId || 'unknown';
    byProvider[provider] = (byProvider[provider] || 0) + 1;
  }

  return {
    dateRange: { startDate, endDate },
    summary: {
      total,
      scheduled,
      completed,
      cancelled,
      noShow,
      rescheduled,
      completionRate: total > 0 ? ((completed / total) * 100).toFixed(1) : 0,
      cancellationRate: total > 0 ? ((cancelled / total) * 100).toFixed(1) : 0,
      noShowRate: total > 0 ? ((noShow / total) * 100).toFixed(1) : 0,
    },
    byDate: Object.entries(byDate).map(([date, data]) => ({ date, ...data })),
    byType,
    byProvider,
  };
}

/**
 * Get channel metrics
 */
async function getChannelMetrics(params: DateRange): Promise<any> {
  const { startDate, endDate } = params;

  // Get interactions
  const result = await docClient.send(new ScanCommand({
    TableName: INTERACTION_TABLE,
    FilterExpression: 'interactionTimestamp BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':start': startDate,
      ':end': endDate,
    },
  }));

  const interactions = result.Items || [];

  // By channel
  const byChannel: Record<string, { inbound: number; outbound: number; total: number }> = {};
  for (const interaction of interactions) {
    const channel = interaction.channel || 'unknown';
    if (!byChannel[channel]) {
      byChannel[channel] = { inbound: 0, outbound: 0, total: 0 };
    }
    byChannel[channel].total++;
    if (interaction.direction === 'INBOUND') {
      byChannel[channel].inbound++;
    } else {
      byChannel[channel].outbound++;
    }
  }

  // By type
  const byType: Record<string, number> = {};
  for (const interaction of interactions) {
    const type = interaction.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }

  // Calculate channel handoffs
  const handoffs = interactions.filter((i: any) => i.type === 'handoff').length;

  return {
    dateRange: { startDate, endDate },
    summary: {
      totalInteractions: interactions.length,
      handoffs,
      uniquePatients: new Set(interactions.map((i: any) => i.patientId)).size,
    },
    byChannel,
    byType,
    channelDistribution: Object.entries(byChannel).map(([channel, data]) => ({
      channel,
      percentage: ((data.total / interactions.length) * 100).toFixed(1),
      ...data,
    })),
  };
}

/**
 * Get payment metrics
 */
async function getPaymentMetrics(params: DateRange): Promise<any> {
  const { startDate, endDate } = params;

  const result = await docClient.send(new ScanCommand({
    TableName: PAYMENT_TABLE,
    FilterExpression: 'createdAt BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':start': startDate,
      ':end': endDate,
    },
  }));

  const payments = result.Items || [];

  // By status
  const completed = payments.filter((p: any) => p.status === 'completed');
  const pending = payments.filter((p: any) => p.status === 'pending');
  const failed = payments.filter((p: any) => p.status === 'failed');
  const refunded = payments.filter((p: any) => p.status === 'refunded');

  const totalCollected = completed.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
  const totalPending = pending.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
  const totalRefunded = refunded.reduce((sum: number, p: any) => sum + (p.refundAmount || p.amount || 0), 0);

  // By type
  const byType: Record<string, { count: number; amount: number }> = {};
  for (const payment of completed) {
    const type = payment.paymentType || 'other';
    if (!byType[type]) {
      byType[type] = { count: 0, amount: 0 };
    }
    byType[type].count++;
    byType[type].amount += payment.amount || 0;
  }

  // By date
  const byDate: Record<string, number> = {};
  for (const payment of completed) {
    const date = payment.completedAt?.split('T')[0] || payment.createdAt?.split('T')[0];
    if (date) {
      byDate[date] = (byDate[date] || 0) + (payment.amount || 0);
    }
  }

  return {
    dateRange: { startDate, endDate },
    summary: {
      totalPayments: payments.length,
      completedCount: completed.length,
      pendingCount: pending.length,
      failedCount: failed.length,
      refundedCount: refunded.length,
      totalCollected,
      totalPending,
      totalRefunded,
      averagePayment: completed.length > 0 ? (totalCollected / completed.length).toFixed(2) : 0,
    },
    byType,
    byDate: Object.entries(byDate).map(([date, amount]) => ({ date, amount })),
  };
}

/**
 * Get campaign metrics
 */
async function getCampaignMetrics(params: DateRange & { campaignId?: string }): Promise<any> {
  const { startDate, endDate, campaignId } = params;

  let filterExpression = 'createdAt BETWEEN :start AND :end';
  const expressionValues: any = {
    ':start': startDate,
    ':end': endDate,
  };

  if (campaignId) {
    filterExpression += ' AND campaignId = :campaignId';
    expressionValues[':campaignId'] = campaignId;
  }

  const result = await docClient.send(new ScanCommand({
    TableName: CAMPAIGN_TABLE,
    FilterExpression: filterExpression,
    ExpressionAttributeValues: expressionValues,
  }));

  const campaigns = result.Items || [];

  // Aggregate metrics
  let totalSent = 0;
  let totalDelivered = 0;
  let totalOpened = 0;
  let totalClicked = 0;
  let totalConverted = 0;

  for (const campaign of campaigns) {
    const metrics = campaign.metrics || {};
    totalSent += metrics.sent || 0;
    totalDelivered += metrics.delivered || 0;
    totalOpened += metrics.opened || 0;
    totalClicked += metrics.clicked || 0;
    totalConverted += metrics.converted || 0;
  }

  // By campaign type
  const byType: Record<string, any> = {};
  for (const campaign of campaigns) {
    const type = campaign.campaignType || 'unknown';
    if (!byType[type]) {
      byType[type] = { count: 0, sent: 0, delivered: 0, opened: 0 };
    }
    byType[type].count++;
    const metrics = campaign.metrics || {};
    byType[type].sent += metrics.sent || 0;
    byType[type].delivered += metrics.delivered || 0;
    byType[type].opened += metrics.opened || 0;
  }

  return {
    dateRange: { startDate, endDate },
    summary: {
      totalCampaigns: campaigns.length,
      totalSent,
      totalDelivered,
      totalOpened,
      totalClicked,
      totalConverted,
      deliveryRate: totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(1) : 0,
      openRate: totalDelivered > 0 ? ((totalOpened / totalDelivered) * 100).toFixed(1) : 0,
      clickRate: totalOpened > 0 ? ((totalClicked / totalOpened) * 100).toFixed(1) : 0,
      conversionRate: totalClicked > 0 ? ((totalConverted / totalClicked) * 100).toFixed(1) : 0,
    },
    byType,
    campaigns: campaigns.map((c: any) => ({
      campaignId: c.campaignId,
      name: c.name,
      type: c.campaignType,
      status: c.status,
      metrics: c.metrics,
      createdAt: c.createdAt,
    })),
  };
}

/**
 * Get dashboard summary
 */
async function getDashboardSummary(params: { period?: string }): Promise<any> {
  const { period = 'today' } = params;

  const now = new Date();
  let startDate: string;
  let endDate = now.toISOString();

  if (period === 'today') {
    startDate = new Date(now.setHours(0, 0, 0, 0)).toISOString();
  } else if (period === 'week') {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    startDate = weekAgo.toISOString();
  } else if (period === 'month') {
    const monthAgo = new Date(now);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    startDate = monthAgo.toISOString();
  } else {
    startDate = new Date(now.setHours(0, 0, 0, 0)).toISOString();
  }

  const dateRange = { startDate: startDate.split('T')[0], endDate: endDate.split('T')[0] };

  const [appointments, channels, payments] = await Promise.all([
    getAppointmentMetrics(dateRange),
    getChannelMetrics(dateRange),
    getPaymentMetrics(dateRange),
  ]);

  return {
    period,
    dateRange,
    appointments: appointments.summary,
    channels: channels.summary,
    payments: payments.summary,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get trends
 */
async function getTrends(params: { metric: string; period?: string }): Promise<any> {
  const { metric, period = 'week' } = params;

  const now = new Date();
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 7;

  const trends: Array<{ date: string; value: number }> = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    // In production, would have pre-aggregated data
    trends.push({ date: dateStr, value: Math.floor(Math.random() * 50) + 10 });
  }

  return {
    metric,
    period,
    trends,
    change: calculateChange(trends),
  };
}

/**
 * Get agent performance
 */
async function getAgentPerformance(params: DateRange & { agentId?: string }): Promise<any> {
  // In production, would track agent-specific metrics
  return {
    dateRange: params,
    agents: [
      {
        agentId: 'agent-1',
        name: 'Agent 1',
        metrics: {
          handledContacts: 45,
          averageHandleTime: '4:32',
          customerSatisfaction: 4.8,
          firstContactResolution: 92,
        },
      },
    ],
  };
}

// Helper functions
function calculateChange(trends: Array<{ date: string; value: number }>): number {
  if (trends.length < 2) return 0;

  const firstHalf = trends.slice(0, Math.floor(trends.length / 2));
  const secondHalf = trends.slice(Math.floor(trends.length / 2));

  const firstAvg = firstHalf.reduce((sum, t) => sum + t.value, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((sum, t) => sum + t.value, 0) / secondHalf.length;

  if (firstAvg === 0) return 0;
  return ((secondAvg - firstAvg) / firstAvg) * 100;
}
