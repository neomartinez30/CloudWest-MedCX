import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { Phase1FoundationStack } from '../phase1-foundation/foundation-stack';
import { Phase2Patient360Stack } from '../phase2-patient360/patient360-stack';
import { Phase3OmnichannelStack } from '../phase3-omnichannel/omnichannel-stack';
import * as path from 'path';

export interface Phase7MarketingStackProps extends cdk.StackProps {
  envName: string;
  foundationStack: Phase1FoundationStack;
  patient360Stack: Phase2Patient360Stack;
  omnichannelStack: Phase3OmnichannelStack;
}

export class Phase7MarketingStack extends cdk.Stack {
  public readonly campaignTable: dynamodb.Table;
  public readonly campaignManagerFunction: lambda.Function;
  public readonly segmentBuilderFunction: lambda.Function;
  public readonly outreachSenderFunction: lambda.Function;
  public readonly campaignAnalyticsFunction: lambda.Function;
  public readonly wellnessReminderFunction: lambda.Function;
  public readonly campaignStateMachine: stepfunctions.StateMachine;
  public readonly marketingApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: Phase7MarketingStackProps) {
    super(scope, id, props);

    const { envName, foundationStack, patient360Stack, omnichannelStack } = props;

    // ========================================================================
    // Campaign Table - Stores marketing campaigns and their status
    // ========================================================================
    this.campaignTable = new dynamodb.Table(this, 'CampaignTable', {
      tableName: `medcx-${envName}-campaigns`,
      partitionKey: { name: 'campaignId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordType', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: foundationStack.encryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: Campaigns by status
    this.campaignTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'scheduledDate', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: Campaigns by type
    this.campaignTable.addGlobalSecondaryIndex({
      indexName: 'type-index',
      partitionKey: { name: 'campaignType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========================================================================
    // Common Lambda environment variables
    // ========================================================================
    const commonEnvVars = {
      PATIENT_TABLE: foundationStack.patientTable.tableName,
      CONVERSATION_TABLE: foundationStack.conversationTable.tableName,
      APPOINTMENT_TABLE: foundationStack.appointmentTable.tableName,
      INTERACTION_TABLE: foundationStack.interactionTable.tableName,
      CAMPAIGN_TABLE: this.campaignTable.tableName,
      EVENT_BUS_NAME: foundationStack.eventBus.eventBusName,
      OUTBOUND_QUEUE_URL: omnichannelStack.outboundMessageQueue.queueUrl,
      ENVIRONMENT: envName,
    };

    // ========================================================================
    // Lambda Layer for shared utilities
    // ========================================================================
    const sharedLayer = new lambda.LayerVersion(this, 'MarketingSharedLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../lambdas/layers/shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared utilities for Marketing Lambda functions',
    });

    // ========================================================================
    // Campaign Manager Lambda
    // CRUD operations for marketing campaigns
    // ========================================================================
    this.campaignManagerFunction = new nodejs.NodejsFunction(this, 'CampaignManager', {
      functionName: `medcx-${envName}-campaign-manager`,
      entry: path.join(__dirname, '../../../lambdas/marketing/campaign-manager.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    this.campaignTable.grantReadWriteData(this.campaignManagerFunction);
    foundationStack.patientTable.grantReadData(this.campaignManagerFunction);
    foundationStack.eventBus.grantPutEventsTo(this.campaignManagerFunction);

    // ========================================================================
    // Segment Builder Lambda
    // Builds patient segments for targeted campaigns
    // ========================================================================
    this.segmentBuilderFunction = new nodejs.NodejsFunction(this, 'SegmentBuilder', {
      functionName: `medcx-${envName}-segment-builder`,
      entry: path.join(__dirname, '../../../lambdas/marketing/segment-builder.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadData(this.segmentBuilderFunction);
    foundationStack.appointmentTable.grantReadData(this.segmentBuilderFunction);
    foundationStack.interactionTable.grantReadData(this.segmentBuilderFunction);
    this.campaignTable.grantReadWriteData(this.segmentBuilderFunction);
    foundationStack.eventBus.grantPutEventsTo(this.segmentBuilderFunction);

    // Pinpoint permissions for segment creation
    this.segmentBuilderFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'mobiletargeting:CreateSegment',
        'mobiletargeting:GetSegment',
        'mobiletargeting:GetSegments',
        'mobiletargeting:UpdateSegment',
        'mobiletargeting:DeleteSegment',
      ],
      resources: [`arn:aws:mobiletargeting:${this.region}:${this.account}:apps/*`],
    }));

    // ========================================================================
    // Outreach Sender Lambda
    // Sends campaign messages to patients
    // ========================================================================
    this.outreachSenderFunction = new nodejs.NodejsFunction(this, 'OutreachSender', {
      functionName: `medcx-${envName}-outreach-sender`,
      entry: path.join(__dirname, '../../../lambdas/marketing/outreach-sender.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadData(this.outreachSenderFunction);
    foundationStack.conversationTable.grantReadWriteData(this.outreachSenderFunction);
    this.campaignTable.grantReadWriteData(this.outreachSenderFunction);
    foundationStack.eventBus.grantPutEventsTo(this.outreachSenderFunction);
    omnichannelStack.outboundMessageQueue.grantSendMessages(this.outreachSenderFunction);

    // Pinpoint permissions for sending messages
    this.outreachSenderFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'mobiletargeting:SendMessages',
        'mobiletargeting:SendUsersMessages',
        'mobiletargeting:CreateCampaign',
        'mobiletargeting:GetCampaign',
        'mobiletargeting:UpdateCampaign',
        'mobiletargeting:PutEvents',
      ],
      resources: [`arn:aws:mobiletargeting:${this.region}:${this.account}:apps/*`],
    }));

    // ========================================================================
    // Campaign Analytics Lambda
    // Generates analytics for marketing campaigns
    // ========================================================================
    this.campaignAnalyticsFunction = new nodejs.NodejsFunction(this, 'CampaignAnalytics', {
      functionName: `medcx-${envName}-campaign-analytics`,
      entry: path.join(__dirname, '../../../lambdas/marketing/campaign-analytics.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    this.campaignTable.grantReadData(this.campaignAnalyticsFunction);
    foundationStack.conversationTable.grantReadData(this.campaignAnalyticsFunction);
    foundationStack.interactionTable.grantReadData(this.campaignAnalyticsFunction);

    // Pinpoint analytics permissions
    this.campaignAnalyticsFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'mobiletargeting:GetCampaignActivities',
        'mobiletargeting:GetCampaignVersions',
        'mobiletargeting:GetApplicationDateRangeKpi',
        'mobiletargeting:GetCampaignDateRangeKpi',
      ],
      resources: [`arn:aws:mobiletargeting:${this.region}:${this.account}:apps/*`],
    }));

    // ========================================================================
    // Wellness Reminder Lambda
    // Sends proactive wellness reminders to patients
    // ========================================================================
    this.wellnessReminderFunction = new nodejs.NodejsFunction(this, 'WellnessReminder', {
      functionName: `medcx-${envName}-wellness-reminder`,
      entry: path.join(__dirname, '../../../lambdas/marketing/wellness-reminder.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        WELLNESS_CHECK_DAYS: '180', // Send wellness check after 180 days of no appointment
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadData(this.wellnessReminderFunction);
    foundationStack.appointmentTable.grantReadData(this.wellnessReminderFunction);
    foundationStack.conversationTable.grantReadWriteData(this.wellnessReminderFunction);
    foundationStack.eventBus.grantPutEventsTo(this.wellnessReminderFunction);
    omnichannelStack.outboundMessageQueue.grantSendMessages(this.wellnessReminderFunction);

    // ========================================================================
    // Campaign Execution State Machine
    // Orchestrates campaign execution workflow
    // ========================================================================

    // Step 1: Build segment
    const buildSegment = new tasks.LambdaInvoke(this, 'BuildSegment', {
      lambdaFunction: this.segmentBuilderFunction,
      outputPath: '$.Payload',
    });

    // Step 2: Validate campaign
    const validateCampaign = new stepfunctions.Choice(this, 'ValidateCampaign');

    // Step 3: Send to patients (parallel execution with Map state)
    const sendToPatients = new tasks.LambdaInvoke(this, 'SendToPatients', {
      lambdaFunction: this.outreachSenderFunction,
      outputPath: '$.Payload',
    });

    // Step 4: Update campaign status
    const updateCampaignStatus = new tasks.LambdaInvoke(this, 'UpdateCampaignStatus', {
      lambdaFunction: this.campaignManagerFunction,
      payload: stepfunctions.TaskInput.fromObject({
        action: 'updateStatus',
        campaignId: stepfunctions.JsonPath.stringAt('$.campaignId'),
        status: 'COMPLETED',
      }),
      outputPath: '$.Payload',
    });

    // Error handling
    const campaignError = new tasks.LambdaInvoke(this, 'CampaignError', {
      lambdaFunction: this.campaignManagerFunction,
      payload: stepfunctions.TaskInput.fromObject({
        action: 'updateStatus',
        campaignId: stepfunctions.JsonPath.stringAt('$.campaignId'),
        status: 'FAILED',
        error: stepfunctions.JsonPath.stringAt('$.error'),
      }),
      outputPath: '$.Payload',
    });

    // Empty segment handling
    const emptySegment = new stepfunctions.Pass(this, 'EmptySegment', {
      result: stepfunctions.Result.fromObject({ status: 'no_patients' }),
    });

    // Build state machine
    validateCampaign
      .when(
        stepfunctions.Condition.numberGreaterThan('$.segmentSize', 0),
        sendToPatients.next(updateCampaignStatus)
      )
      .otherwise(emptySegment);

    const definition = buildSegment
      .addCatch(campaignError, {
        resultPath: '$.error',
      })
      .next(validateCampaign);

    this.campaignStateMachine = new stepfunctions.StateMachine(this, 'CampaignStateMachine', {
      stateMachineName: `medcx-${envName}-campaign-execution`,
      definition,
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
    });

    // Grant state machine permissions
    this.segmentBuilderFunction.grantInvoke(this.campaignStateMachine);
    this.outreachSenderFunction.grantInvoke(this.campaignStateMachine);
    this.campaignManagerFunction.grantInvoke(this.campaignStateMachine);

    // ========================================================================
    // Marketing API Gateway
    // ========================================================================
    this.marketingApi = new apigateway.RestApi(this, 'MarketingApi', {
      restApiName: `medcx-${envName}-marketing-api`,
      description: 'Marketing and Outreach API for CloudWest MedCX',
      deployOptions: {
        stageName: envName,
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.OFF,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
      },
    });

    // Campaign endpoints
    const campaignsResource = this.marketingApi.root.addResource('campaigns');

    // Create campaign
    campaignsResource.addMethod('POST', new apigateway.LambdaIntegration(this.campaignManagerFunction), {
      apiKeyRequired: true,
    });

    // List campaigns
    campaignsResource.addMethod('GET', new apigateway.LambdaIntegration(this.campaignManagerFunction), {
      apiKeyRequired: true,
    });

    // Campaign by ID
    const campaignByIdResource = campaignsResource.addResource('{campaignId}');
    campaignByIdResource.addMethod('GET', new apigateway.LambdaIntegration(this.campaignManagerFunction), {
      apiKeyRequired: true,
    });
    campaignByIdResource.addMethod('PUT', new apigateway.LambdaIntegration(this.campaignManagerFunction), {
      apiKeyRequired: true,
    });
    campaignByIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(this.campaignManagerFunction), {
      apiKeyRequired: true,
    });

    // Execute campaign
    const executeResource = campaignByIdResource.addResource('execute');
    executeResource.addMethod('POST', new apigateway.LambdaIntegration(this.campaignManagerFunction), {
      apiKeyRequired: true,
    });

    // Campaign analytics
    const analyticsResource = campaignByIdResource.addResource('analytics');
    analyticsResource.addMethod('GET', new apigateway.LambdaIntegration(this.campaignAnalyticsFunction), {
      apiKeyRequired: true,
    });

    // Segment endpoints
    const segmentsResource = this.marketingApi.root.addResource('segments');

    // Create segment
    segmentsResource.addMethod('POST', new apigateway.LambdaIntegration(this.segmentBuilderFunction), {
      apiKeyRequired: true,
    });

    // Preview segment
    const previewResource = segmentsResource.addResource('preview');
    previewResource.addMethod('POST', new apigateway.LambdaIntegration(this.segmentBuilderFunction), {
      apiKeyRequired: true,
    });

    // Outreach endpoints
    const outreachResource = this.marketingApi.root.addResource('outreach');

    // Send one-off message
    outreachResource.addMethod('POST', new apigateway.LambdaIntegration(this.outreachSenderFunction), {
      apiKeyRequired: true,
    });

    // Wellness reminders
    const wellnessResource = outreachResource.addResource('wellness');
    wellnessResource.addMethod('POST', new apigateway.LambdaIntegration(this.wellnessReminderFunction), {
      apiKeyRequired: true,
    });

    // Overall marketing analytics
    const marketingAnalyticsResource = this.marketingApi.root.addResource('analytics');
    marketingAnalyticsResource.addMethod('GET', new apigateway.LambdaIntegration(this.campaignAnalyticsFunction), {
      apiKeyRequired: true,
    });

    // API Key
    const apiKey = this.marketingApi.addApiKey('MarketingApiKey', {
      apiKeyName: `medcx-${envName}-marketing-api-key`,
    });

    const usagePlan = this.marketingApi.addUsagePlan('MarketingApiUsagePlan', {
      name: `medcx-${envName}-marketing-usage-plan`,
      throttle: {
        rateLimit: 50,
        burstLimit: 100,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.marketingApi.deploymentStage });

    // ========================================================================
    // EventBridge Rules
    // ========================================================================

    // Scheduled campaign execution
    new events.Rule(this, 'ScheduledCampaignRule', {
      ruleName: `medcx-${envName}-scheduled-campaigns`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.marketing'],
        detailType: ['CampaignScheduled'],
      },
      targets: [new targets.SfnStateMachine(this.campaignStateMachine)],
    });

    // Daily wellness reminder check (runs at 9 AM UTC)
    new events.Rule(this, 'DailyWellnessCheckRule', {
      ruleName: `medcx-${envName}-daily-wellness-check`,
      schedule: events.Schedule.cron({ hour: '9', minute: '0' }),
      targets: [new targets.LambdaFunction(this.wellnessReminderFunction)],
    });

    // Campaign status updates
    new events.Rule(this, 'CampaignStatusRule', {
      ruleName: `medcx-${envName}-campaign-status`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.marketing'],
        detailType: ['CampaignStatusChanged'],
      },
      targets: [new targets.LambdaFunction(this.campaignAnalyticsFunction)],
    });

    // ========================================================================
    // CloudWatch Log Groups
    // ========================================================================
    new logs.LogGroup(this, 'MarketingLogs', {
      logGroupName: `/medcx/${envName}/marketing`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'MarketingApiUrl', {
      value: this.marketingApi.url,
      description: 'Marketing API URL',
      exportName: `medcx-${envName}-marketing-api-url`,
    });

    new cdk.CfnOutput(this, 'CampaignTableName', {
      value: this.campaignTable.tableName,
      description: 'Campaign DynamoDB table name',
      exportName: `medcx-${envName}-campaign-table`,
    });

    new cdk.CfnOutput(this, 'CampaignStateMachineArn', {
      value: this.campaignStateMachine.stateMachineArn,
      description: 'Campaign Execution State Machine ARN',
      exportName: `medcx-${envName}-campaign-state-machine-arn`,
    });

    new cdk.CfnOutput(this, 'SegmentBuilderArn', {
      value: this.segmentBuilderFunction.functionArn,
      description: 'Segment Builder Lambda ARN',
      exportName: `medcx-${envName}-segment-builder-arn`,
    });

    new cdk.CfnOutput(this, 'OutreachSenderArn', {
      value: this.outreachSenderFunction.functionArn,
      description: 'Outreach Sender Lambda ARN',
      exportName: `medcx-${envName}-outreach-sender-arn`,
    });

    new cdk.CfnOutput(this, 'WellnessReminderArn', {
      value: this.wellnessReminderFunction.functionArn,
      description: 'Wellness Reminder Lambda ARN',
      exportName: `medcx-${envName}-wellness-reminder-arn`,
    });
  }
}
