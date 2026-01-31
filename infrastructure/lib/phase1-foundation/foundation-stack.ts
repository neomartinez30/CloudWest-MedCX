import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface Phase1FoundationStackProps extends cdk.StackProps {
  envName: string;
}

export class Phase1FoundationStack extends cdk.Stack {
  // Exported resources for other stacks
  public readonly patientTable: dynamodb.Table;
  public readonly conversationTable: dynamodb.Table;
  public readonly appointmentTable: dynamodb.Table;
  public readonly interactionTable: dynamodb.Table;
  public readonly documentsBucket: s3.Bucket;
  public readonly recordingsBucket: s3.Bucket;
  public readonly encryptionKey: kms.Key;
  public readonly eventBus: cdk.aws_events.EventBus;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly alertsTopic: sns.Topic;
  public readonly googleCalendarSecret: secretsmanager.Secret;
  public readonly stripeSecret: secretsmanager.Secret;
  public readonly appleBusinessSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: Phase1FoundationStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // ========================================================================
    // KMS Key for encryption
    // ========================================================================
    this.encryptionKey = new kms.Key(this, 'MedCXEncryptionKey', {
      alias: `medcx-${envName}-encryption-key`,
      description: 'Encryption key for MedCX patient data and PHI',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================================================
    // SNS Topic for alerts
    // ========================================================================
    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `medcx-${envName}-alerts`,
      displayName: 'MedCX System Alerts',
      masterKey: this.encryptionKey,
    });

    // ========================================================================
    // Dead Letter Queue for failed messages
    // ========================================================================
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `medcx-${envName}-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.encryptionKey,
      retentionPeriod: cdk.Duration.days(14),
    });

    // ========================================================================
    // EventBridge Event Bus
    // ========================================================================
    this.eventBus = new cdk.aws_events.EventBus(this, 'MedCXEventBus', {
      eventBusName: `medcx-${envName}-events`,
    });

    // Archive events for audit/compliance
    new cdk.aws_events.Archive(this, 'EventArchive', {
      sourceEventBus: this.eventBus,
      archiveName: `medcx-${envName}-archive`,
      description: 'Archive of all MedCX events for compliance',
      retention: cdk.Duration.days(365),
      eventPattern: {
        source: [{ prefix: 'medcx' }] as any,
      },
    });

    // ========================================================================
    // DynamoDB Tables
    // ========================================================================

    // Patient Table - Core patient identity and profile
    this.patientTable = new dynamodb.Table(this, 'PatientTable', {
      tableName: `medcx-${envName}-patients`,
      partitionKey: { name: 'patientId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordType', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: Lookup by phone number (primary identity resolver)
    this.patientTable.addGlobalSecondaryIndex({
      indexName: 'phone-index',
      partitionKey: { name: 'phoneNumber', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Lookup by email
    this.patientTable.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Lookup by external ID (for EHR integration)
    this.patientTable.addGlobalSecondaryIndex({
      indexName: 'externalId-index',
      partitionKey: { name: 'externalId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Conversation Table - Unified conversation threads across channels
    this.conversationTable = new dynamodb.Table(this, 'ConversationTable', {
      tableName: `medcx-${envName}-conversations`,
      partitionKey: { name: 'patientId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'messageTimestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: Lookup by conversation thread
    this.conversationTable.addGlobalSecondaryIndex({
      indexName: 'thread-index',
      partitionKey: { name: 'threadId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'messageTimestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Active conversations by status
    this.conversationTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lastUpdated', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Appointment Table - Appointment scheduling and management
    this.appointmentTable = new dynamodb.Table(this, 'AppointmentTable', {
      tableName: `medcx-${envName}-appointments`,
      partitionKey: { name: 'appointmentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: Appointments by patient
    this.appointmentTable.addGlobalSecondaryIndex({
      indexName: 'patient-index',
      partitionKey: { name: 'patientId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'appointmentDateTime', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Appointments by provider
    this.appointmentTable.addGlobalSecondaryIndex({
      indexName: 'provider-index',
      partitionKey: { name: 'providerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'appointmentDateTime', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Appointments by date (for daily scheduling view)
    this.appointmentTable.addGlobalSecondaryIndex({
      indexName: 'date-index',
      partitionKey: { name: 'appointmentDate', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'appointmentTime', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Appointments by Google Calendar Event ID
    this.appointmentTable.addGlobalSecondaryIndex({
      indexName: 'googleEventId-index',
      partitionKey: { name: 'googleCalendarEventId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Interaction Table - All patient interactions (calls, messages, tasks)
    this.interactionTable = new dynamodb.Table(this, 'InteractionTable', {
      tableName: `medcx-${envName}-interactions`,
      partitionKey: { name: 'patientId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'interactionTimestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: Interactions by Connect contact ID
    this.interactionTable.addGlobalSecondaryIndex({
      indexName: 'contactId-index',
      partitionKey: { name: 'connectContactId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Interactions by type
    this.interactionTable.addGlobalSecondaryIndex({
      indexName: 'type-index',
      partitionKey: { name: 'interactionType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'interactionTimestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========================================================================
    // S3 Buckets
    // ========================================================================

    // Documents Bucket - Insurance cards, IDs, forms
    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: `medcx-${envName}-documents-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      eventBridgeEnabled: true, // Enable EventBridge notifications for cross-stack triggers
      lifecycleRules: [
        {
          id: 'archive-old-documents',
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'], // Will be restricted in production
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Recordings Bucket - Call recordings and transcripts
    this.recordingsBucket = new s3.Bucket(this, 'RecordingsBucket', {
      bucketName: `medcx-${envName}-recordings-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'archive-old-recordings',
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          expiration: cdk.Duration.days(2555), // 7 years for HIPAA compliance
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================================================
    // Secrets Manager - API Keys and Credentials
    // ========================================================================

    // Google Calendar API credentials
    this.googleCalendarSecret = new secretsmanager.Secret(this, 'GoogleCalendarSecret', {
      secretName: `medcx/${envName}/google-calendar`,
      description: 'Google Calendar API credentials for appointment scheduling',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          clientId: 'PLACEHOLDER',
          clientSecret: 'PLACEHOLDER',
          refreshToken: 'PLACEHOLDER',
          calendarId: 'PLACEHOLDER',
        }),
        generateStringKey: 'apiKey',
      },
    });

    // Stripe Payment credentials
    this.stripeSecret = new secretsmanager.Secret(this, 'StripeSecret', {
      secretName: `medcx/${envName}/stripe`,
      description: 'Stripe API credentials for payment processing',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          secretKey: 'PLACEHOLDER',
          publishableKey: 'PLACEHOLDER',
          webhookSecret: 'PLACEHOLDER',
        }),
        generateStringKey: 'apiKey',
      },
    });

    // Apple Messages for Business credentials
    this.appleBusinessSecret = new secretsmanager.Secret(this, 'AppleBusinessSecret', {
      secretName: `medcx/${envName}/apple-business`,
      description: 'Apple Messages for Business credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          businessId: 'PLACEHOLDER',
          apiKey: 'PLACEHOLDER',
          privateKey: 'PLACEHOLDER',
        }),
        generateStringKey: 'secret',
      },
    });

    // ========================================================================
    // CloudWatch Log Groups
    // ========================================================================

    new logs.LogGroup(this, 'ApplicationLogs', {
      logGroupName: `/medcx/${envName}/application`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new logs.LogGroup(this, 'AuditLogs', {
      logGroupName: `/medcx/${envName}/audit`,
      retention: logs.RetentionDays.TEN_YEARS, // HIPAA compliance
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'PatientTableName', {
      value: this.patientTable.tableName,
      description: 'Patient DynamoDB table name',
      exportName: `medcx-${envName}-patient-table`,
    });

    new cdk.CfnOutput(this, 'ConversationTableName', {
      value: this.conversationTable.tableName,
      description: 'Conversation DynamoDB table name',
      exportName: `medcx-${envName}-conversation-table`,
    });

    new cdk.CfnOutput(this, 'AppointmentTableName', {
      value: this.appointmentTable.tableName,
      description: 'Appointment DynamoDB table name',
      exportName: `medcx-${envName}-appointment-table`,
    });

    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: this.documentsBucket.bucketName,
      description: 'Documents S3 bucket name',
      exportName: `medcx-${envName}-documents-bucket`,
    });

    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBus.eventBusName,
      description: 'EventBridge event bus name',
      exportName: `medcx-${envName}-event-bus`,
    });

    new cdk.CfnOutput(this, 'EncryptionKeyArn', {
      value: this.encryptionKey.keyArn,
      description: 'KMS encryption key ARN',
      exportName: `medcx-${envName}-encryption-key`,
    });
  }
}
