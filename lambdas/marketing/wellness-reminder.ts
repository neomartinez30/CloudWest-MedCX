import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});
const eventBridge = new EventBridgeClient({});

const PATIENT_TABLE = process.env.PATIENT_TABLE!;
const APPOINTMENT_TABLE = process.env.APPOINTMENT_TABLE!;
const REMINDER_TABLE = process.env.REMINDER_TABLE!;
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;
const APPLE_HANDLER_ARN = process.env.APPLE_HANDLER_ARN!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

type ReminderType = 'annual_checkup' | 'flu_shot' | 'dental_cleaning' | 'eye_exam' | 'mammogram' | 'colonoscopy' | 'custom';

interface WellnessReminder {
  reminderId: string;
  patientId: string;
  reminderType: ReminderType;
  dueDate: string;
  lastCompleted?: string;
  frequency?: number; // months
  status: 'pending' | 'sent' | 'scheduled' | 'completed' | 'dismissed';
  channel?: string;
  sentAt?: string;
  scheduledAppointmentId?: string;
}

/**
 * Wellness Reminder Lambda
 *
 * Proactive patient wellness outreach:
 * - Identify patients due for checkups
 * - Send personalized reminders
 * - Track reminder responses
 * - Support scheduling via interactive messages
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Wellness Reminder Event:', JSON.stringify(event, null, 2));

  try {
    // Handle scheduled execution (EventBridge)
    if (event.source === 'aws.scheduler' || event['detail-type'] === 'ScheduledWellnessCheck') {
      return runDailyWellnessCheck();
    }

    const { action, ...data } = event;

    switch (action) {
      case 'runDailyCheck':
        return runDailyWellnessCheck();

      case 'checkPatientWellness':
        return checkPatientWellness(data.patientId);

      case 'sendReminder':
        return sendReminder(data);

      case 'markCompleted':
        return markCompleted(data.reminderId, data.appointmentId);

      case 'dismissReminder':
        return dismissReminder(data.reminderId, data.reason);

      case 'getPatientReminders':
        return getPatientReminders(data.patientId);

      case 'createCustomReminder':
        return createCustomReminder(data);

      case 'getWellnessReport':
        return getWellnessReport(data);

      default:
        return { error: 'Unknown action' };
    }
  } catch (error) {
    console.error('Error in wellness reminder:', error);
    return {
      error: 'Wellness reminder failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * Run daily wellness check for all patients
 */
async function runDailyWellnessCheck(): Promise<any> {
  const now = new Date();
  const sent = [];
  const skipped = [];

  // Get all patients
  const result = await docClient.send(new ScanCommand({
    TableName: PATIENT_TABLE,
    FilterExpression: 'recordType = :profile AND attribute_exists(dateOfBirth)',
    ExpressionAttributeValues: { ':profile': 'PROFILE' },
  }));

  const patients = result.Items || [];

  for (const patient of patients) {
    const dueReminders = await checkPatientWellness(patient.patientId);

    if (dueReminders.reminders && dueReminders.reminders.length > 0) {
      for (const reminder of dueReminders.reminders) {
        if (reminder.shouldSend) {
          await sendReminder({
            patientId: patient.patientId,
            reminderType: reminder.type,
            dueDate: reminder.dueDate,
          });
          sent.push({ patientId: patient.patientId, type: reminder.type });
        } else {
          skipped.push({ patientId: patient.patientId, type: reminder.type, reason: reminder.reason });
        }
      }
    }
  }

  await emitEvent('DailyWellnessCheckCompleted', {
    patientsChecked: patients.length,
    remindersSent: sent.length,
    remindersSkipped: skipped.length,
    timestamp: now.toISOString(),
  });

  return {
    success: true,
    patientsChecked: patients.length,
    remindersSent: sent.length,
    remindersSkipped: skipped.length,
  };
}

/**
 * Check wellness status for a specific patient
 */
async function checkPatientWellness(patientId: string): Promise<any> {
  const patient = await getPatient(patientId);
  if (!patient) {
    return { error: 'Patient not found' };
  }

  const age = calculateAge(patient.dateOfBirth);
  const reminders: Array<{
    type: ReminderType;
    dueDate: string;
    shouldSend: boolean;
    reason?: string;
    lastCompleted?: string;
  }> = [];

  // Annual checkup - everyone
  const annualCheckup = await checkReminderDue(patientId, 'annual_checkup', 12);
  if (annualCheckup.due) {
    reminders.push({
      type: 'annual_checkup',
      dueDate: annualCheckup.dueDate,
      shouldSend: !annualCheckup.recentlySent,
      lastCompleted: annualCheckup.lastCompleted,
      reason: annualCheckup.recentlySent ? 'recently_sent' : undefined,
    });
  }

  // Flu shot - everyone, yearly in fall
  const now = new Date();
  if (now.getMonth() >= 8 && now.getMonth() <= 11) { // Sept-Dec
    const fluShot = await checkReminderDue(patientId, 'flu_shot', 12);
    if (fluShot.due) {
      reminders.push({
        type: 'flu_shot',
        dueDate: fluShot.dueDate,
        shouldSend: !fluShot.recentlySent,
        lastCompleted: fluShot.lastCompleted,
        reason: fluShot.recentlySent ? 'recently_sent' : undefined,
      });
    }
  }

  // Dental cleaning - everyone, every 6 months
  const dentalCleaning = await checkReminderDue(patientId, 'dental_cleaning', 6);
  if (dentalCleaning.due) {
    reminders.push({
      type: 'dental_cleaning',
      dueDate: dentalCleaning.dueDate,
      shouldSend: !dentalCleaning.recentlySent,
      lastCompleted: dentalCleaning.lastCompleted,
      reason: dentalCleaning.recentlySent ? 'recently_sent' : undefined,
    });
  }

  // Eye exam - yearly for adults
  if (age >= 18) {
    const eyeExam = await checkReminderDue(patientId, 'eye_exam', 12);
    if (eyeExam.due) {
      reminders.push({
        type: 'eye_exam',
        dueDate: eyeExam.dueDate,
        shouldSend: !eyeExam.recentlySent,
        lastCompleted: eyeExam.lastCompleted,
        reason: eyeExam.recentlySent ? 'recently_sent' : undefined,
      });
    }
  }

  // Mammogram - women 40+, yearly
  if (patient.gender === 'female' && age >= 40) {
    const mammogram = await checkReminderDue(patientId, 'mammogram', 12);
    if (mammogram.due) {
      reminders.push({
        type: 'mammogram',
        dueDate: mammogram.dueDate,
        shouldSend: !mammogram.recentlySent,
        lastCompleted: mammogram.lastCompleted,
        reason: mammogram.recentlySent ? 'recently_sent' : undefined,
      });
    }
  }

  // Colonoscopy - 45+, every 10 years
  if (age >= 45) {
    const colonoscopy = await checkReminderDue(patientId, 'colonoscopy', 120);
    if (colonoscopy.due) {
      reminders.push({
        type: 'colonoscopy',
        dueDate: colonoscopy.dueDate,
        shouldSend: !colonoscopy.recentlySent,
        lastCompleted: colonoscopy.lastCompleted,
        reason: colonoscopy.recentlySent ? 'recently_sent' : undefined,
      });
    }
  }

  return {
    patientId,
    age,
    reminders,
    dueCount: reminders.filter(r => r.shouldSend).length,
  };
}

/**
 * Send wellness reminder
 */
async function sendReminder(data: {
  patientId: string;
  reminderType: ReminderType;
  dueDate?: string;
}): Promise<any> {
  const { patientId, reminderType, dueDate } = data;
  const reminderId = randomUUID();
  const now = new Date().toISOString();

  const patient = await getPatient(patientId);
  if (!patient) {
    return { error: 'Patient not found' };
  }

  const message = buildReminderMessage(reminderType, patient);
  const channel = patient.preferredChannel || 'sms';

  // Store reminder
  const reminder: WellnessReminder = {
    reminderId,
    patientId,
    reminderType,
    dueDate: dueDate || now,
    status: 'sent',
    channel,
    sentAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: REMINDER_TABLE,
    Item: reminder,
  }));

  // Send message
  await invokeFunction(CHANNEL_ROUTER_ARN, {
    action: 'sendOutbound',
    channel,
    patientId,
    content: message,
    metadata: {
      reminderId,
      reminderType,
    },
  });

  // For Apple Messages, also send interactive message for scheduling
  if (channel === 'apple_messages' || patient.capabilities?.includes('apple_messages')) {
    await sendSchedulingPicker(patientId, reminderType);
  }

  await emitEvent('WellnessReminderSent', {
    reminderId,
    patientId,
    reminderType,
    channel,
    timestamp: now,
  });

  return {
    success: true,
    reminderId,
    reminderType,
    channel,
  };
}

/**
 * Mark reminder as completed
 */
async function markCompleted(reminderId: string, appointmentId?: string): Promise<any> {
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: REMINDER_TABLE,
    Item: {
      reminderId,
      status: 'completed',
      completedAt: now,
      scheduledAppointmentId: appointmentId,
    },
  }));

  await emitEvent('WellnessReminderCompleted', {
    reminderId,
    appointmentId,
    timestamp: now,
  });

  return { success: true, reminderId, status: 'completed' };
}

/**
 * Dismiss reminder
 */
async function dismissReminder(reminderId: string, reason?: string): Promise<any> {
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: REMINDER_TABLE,
    Item: {
      reminderId,
      status: 'dismissed',
      dismissedAt: now,
      dismissReason: reason,
    },
  }));

  return { success: true, reminderId, status: 'dismissed' };
}

/**
 * Get patient reminders
 */
async function getPatientReminders(patientId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: REMINDER_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    ExpressionAttributeValues: { ':patientId': patientId },
    ScanIndexForward: false,
  }));

  return {
    patientId,
    reminders: result.Items || [],
  };
}

/**
 * Create custom reminder
 */
async function createCustomReminder(data: {
  patientId: string;
  description: string;
  dueDate: string;
  frequency?: number;
}): Promise<any> {
  const reminderId = randomUUID();
  const now = new Date().toISOString();

  const reminder: WellnessReminder = {
    reminderId,
    patientId: data.patientId,
    reminderType: 'custom',
    dueDate: data.dueDate,
    frequency: data.frequency,
    status: 'pending',
  };

  await docClient.send(new PutCommand({
    TableName: REMINDER_TABLE,
    Item: {
      ...reminder,
      description: data.description,
      createdAt: now,
    },
  }));

  return {
    success: true,
    reminderId,
    reminder,
  };
}

/**
 * Get wellness report
 */
async function getWellnessReport(params: {
  startDate?: string;
  endDate?: string;
}): Promise<any> {
  const result = await docClient.send(new ScanCommand({
    TableName: REMINDER_TABLE,
    Limit: 1000,
  }));

  const reminders = result.Items || [];

  const byType: Record<string, { sent: number; completed: number; dismissed: number }> = {};
  let totalSent = 0;
  let totalCompleted = 0;
  let totalDismissed = 0;

  for (const reminder of reminders) {
    const type = reminder.reminderType;
    if (!byType[type]) {
      byType[type] = { sent: 0, completed: 0, dismissed: 0 };
    }

    if (reminder.status === 'sent') {
      byType[type].sent++;
      totalSent++;
    } else if (reminder.status === 'completed') {
      byType[type].completed++;
      totalCompleted++;
    } else if (reminder.status === 'dismissed') {
      byType[type].dismissed++;
      totalDismissed++;
    }
  }

  return {
    summary: {
      totalSent,
      totalCompleted,
      totalDismissed,
      completionRate: totalSent > 0 ? ((totalCompleted / totalSent) * 100).toFixed(1) : '0',
    },
    byType,
  };
}

// Helper functions
async function getPatient(patientId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: PATIENT_TABLE,
    Key: { patientId, recordType: 'PROFILE' },
  }));
  return result.Item;
}

function calculateAge(dateOfBirth: string): number {
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

async function checkReminderDue(
  patientId: string,
  reminderType: ReminderType,
  frequencyMonths: number
): Promise<{
  due: boolean;
  dueDate: string;
  lastCompleted?: string;
  recentlySent: boolean;
}> {
  // Get last completed appointment of this type
  const appointments = await docClient.send(new QueryCommand({
    TableName: APPOINTMENT_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    FilterExpression: 'appointmentType = :type AND #status = :completed',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':patientId': patientId,
      ':type': reminderType,
      ':completed': 'completed',
    },
    ScanIndexForward: false,
    Limit: 1,
  }));

  const lastAppointment = appointments.Items?.[0];
  const lastCompleted = lastAppointment?.appointmentDate;

  // Get recent reminders
  const reminders = await docClient.send(new QueryCommand({
    TableName: REMINDER_TABLE,
    IndexName: 'patient-index',
    KeyConditionExpression: 'patientId = :patientId',
    FilterExpression: 'reminderType = :type',
    ExpressionAttributeValues: {
      ':patientId': patientId,
      ':type': reminderType,
    },
    ScanIndexForward: false,
    Limit: 1,
  }));

  const lastReminder = reminders.Items?.[0];
  const recentlySent = lastReminder?.sentAt &&
    (Date.now() - new Date(lastReminder.sentAt).getTime()) < (30 * 24 * 60 * 60 * 1000); // 30 days

  // Calculate due date
  let dueDate: Date;
  if (lastCompleted) {
    dueDate = new Date(lastCompleted);
    dueDate.setMonth(dueDate.getMonth() + frequencyMonths);
  } else {
    dueDate = new Date(); // Due now if never completed
  }

  return {
    due: dueDate <= new Date(),
    dueDate: dueDate.toISOString().split('T')[0],
    lastCompleted,
    recentlySent: !!recentlySent,
  };
}

function buildReminderMessage(reminderType: ReminderType, patient: any): string {
  const name = patient.firstName || 'there';

  const messages: Record<ReminderType, string> = {
    annual_checkup: `Hi ${name}! It's time for your annual checkup. Regular checkups help catch health issues early. Reply SCHEDULE to book your appointment.`,
    flu_shot: `Hi ${name}! Flu season is here. Protect yourself and others by getting your flu shot. Reply SCHEDULE to book your vaccination.`,
    dental_cleaning: `Hi ${name}! You're due for a dental cleaning. Keeping up with dental care prevents future problems. Reply SCHEDULE to book.`,
    eye_exam: `Hi ${name}! It's time for your annual eye exam. Good vision is important! Reply SCHEDULE to book your appointment.`,
    mammogram: `Hi ${name}! You're due for your annual mammogram. Early detection saves lives. Reply SCHEDULE to book your screening.`,
    colonoscopy: `Hi ${name}! You're due for a colonoscopy screening. This important test can detect issues early. Reply SCHEDULE to book.`,
    custom: `Hi ${name}! You have a health reminder. Reply SCHEDULE to book an appointment.`,
  };

  return messages[reminderType];
}

async function sendSchedulingPicker(patientId: string, reminderType: ReminderType): Promise<void> {
  // Send interactive list picker for appointment types
  await invokeFunction(APPLE_HANDLER_ARN, {
    action: 'sendListPicker',
    patientId,
    title: 'Schedule Your Appointment',
    subtitle: `Book your ${reminderType.replace('_', ' ')}`,
    sections: [{
      title: 'Available Options',
      items: [
        { id: 'schedule_now', title: 'Schedule Now', subtitle: 'See available times' },
        { id: 'call_me', title: 'Call Me', subtitle: 'Have someone call to schedule' },
        { id: 'remind_later', title: 'Remind Me Later', subtitle: 'Get reminded in a week' },
      ],
    }],
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
      Source: 'medcx.wellness',
      DetailType: detailType,
      Detail: JSON.stringify(detail),
    }],
  }));
}
