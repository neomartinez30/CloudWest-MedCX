import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { Phase1FoundationStack } from '../phase1-foundation/foundation-stack';
import { Phase2Patient360Stack } from '../phase2-patient360/patient360-stack';
import { Phase3OmnichannelStack } from '../phase3-omnichannel/omnichannel-stack';
import * as path from 'path';

export interface Phase4GenAIStackProps extends cdk.StackProps {
  envName: string;
  foundationStack: Phase1FoundationStack;
  patient360Stack: Phase2Patient360Stack;
  omnichannelStack: Phase3OmnichannelStack;
}

export class Phase4GenAIStack extends cdk.Stack {
  public readonly lexFulfillmentFunction: lambda.Function;
  public readonly appointmentSchedulerFunction: lambda.Function;
  public readonly bedrockConversationFunction: lambda.Function;
  public readonly interactiveMessageFunction: lambda.Function;
  public readonly contextBuilderFunction: lambda.Function;
  public readonly genaiApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: Phase4GenAIStackProps) {
    super(scope, id, props);

    const { envName, foundationStack, patient360Stack, omnichannelStack } = props;

    // ========================================================================
    // Common Lambda environment variables
    // ========================================================================
    const commonEnvVars = {
      PATIENT_TABLE: foundationStack.patientTable.tableName,
      CONVERSATION_TABLE: foundationStack.conversationTable.tableName,
      APPOINTMENT_TABLE: foundationStack.appointmentTable.tableName,
      INTERACTION_TABLE: foundationStack.interactionTable.tableName,
      EVENT_BUS_NAME: foundationStack.eventBus.eventBusName,
      GOOGLE_CALENDAR_SECRET_ARN: foundationStack.googleCalendarSecret.secretArn,
      BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0',
      ENVIRONMENT: envName,
    };

    // ========================================================================
    // Lambda Layer for shared utilities
    // ========================================================================
    const sharedLayer = new lambda.LayerVersion(this, 'GenAISharedLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../lambdas/layers/shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared utilities for GenAI Lambda functions',
    });

    // ========================================================================
    // Context Builder Lambda
    // Builds patient context for AI conversations
    // ========================================================================
    this.contextBuilderFunction = new nodejs.NodejsFunction(this, 'ContextBuilder', {
      functionName: `medcx-${envName}-context-builder`,
      entry: path.join(__dirname, '../../../lambdas/genai/context-builder.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadData(this.contextBuilderFunction);
    foundationStack.conversationTable.grantReadData(this.contextBuilderFunction);
    foundationStack.appointmentTable.grantReadData(this.contextBuilderFunction);
    foundationStack.interactionTable.grantReadData(this.contextBuilderFunction);

    // ========================================================================
    // Bedrock Conversation Lambda
    // Handles natural language conversations using Amazon Bedrock
    // ========================================================================
    this.bedrockConversationFunction = new nodejs.NodejsFunction(this, 'BedrockConversation', {
      functionName: `medcx-${envName}-bedrock-conversation`,
      entry: path.join(__dirname, '../../../lambdas/genai/bedrock-conversation.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: {
        ...commonEnvVars,
        CONTEXT_BUILDER_ARN: this.contextBuilderFunction.functionArn,
        APPOINTMENT_SCHEDULER_ARN: '', // Will be set after creation
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Bedrock permissions
    this.bedrockConversationFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-instant-v1`,
      ],
    }));

    foundationStack.patientTable.grantReadData(this.bedrockConversationFunction);
    foundationStack.conversationTable.grantReadWriteData(this.bedrockConversationFunction);
    foundationStack.eventBus.grantPutEventsTo(this.bedrockConversationFunction);
    this.contextBuilderFunction.grantInvoke(this.bedrockConversationFunction);

    // ========================================================================
    // Appointment Scheduler Lambda
    // Handles appointment scheduling with Google Calendar integration
    // ========================================================================
    this.appointmentSchedulerFunction = new nodejs.NodejsFunction(this, 'AppointmentScheduler', {
      functionName: `medcx-${envName}-appointment-scheduler`,
      entry: path.join(__dirname, '../../../lambdas/genai/appointment-scheduler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        AVAILABILITY_TABLE: foundationStack.availabilityTable.tableName,
        GOOGLE_SECRETS_ARN: foundationStack.googleCalendarSecret.secretArn,
        CHANNEL_ROUTER_ARN: omnichannelStack.channelRouterFunction.functionArn,
        DEFAULT_APPOINTMENT_DURATION: '30', // minutes
        BUSINESS_HOURS_START: '09:00',
        BUSINESS_HOURS_END: '17:00',
        TIMEZONE: 'America/Los_Angeles',
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.googleCalendarSecret.grantRead(this.appointmentSchedulerFunction);
    foundationStack.patientTable.grantReadData(this.appointmentSchedulerFunction);
    foundationStack.appointmentTable.grantReadWriteData(this.appointmentSchedulerFunction);
    foundationStack.availabilityTable.grantReadData(this.appointmentSchedulerFunction);
    foundationStack.eventBus.grantPutEventsTo(this.appointmentSchedulerFunction);
    omnichannelStack.channelRouterFunction.grantInvoke(this.appointmentSchedulerFunction);

    // Update Bedrock function with scheduler ARN
    this.bedrockConversationFunction.addEnvironment(
      'APPOINTMENT_SCHEDULER_ARN',
      this.appointmentSchedulerFunction.functionArn
    );
    this.appointmentSchedulerFunction.grantInvoke(this.bedrockConversationFunction);

    // ========================================================================
    // Lex Fulfillment Lambda
    // Handles Amazon Lex intent fulfillment with Bedrock integration
    // ========================================================================
    this.lexFulfillmentFunction = new nodejs.NodejsFunction(this, 'LexFulfillment', {
      functionName: `medcx-${envName}-lex-fulfillment`,
      entry: path.join(__dirname, '../../../lambdas/genai/lex-fulfillment.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        BEDROCK_CONVERSATION_ARN: this.bedrockConversationFunction.functionArn,
        APPOINTMENT_SCHEDULER_ARN: this.appointmentSchedulerFunction.functionArn,
        CONTEXT_BUILDER_ARN: this.contextBuilderFunction.functionArn,
        IDENTITY_RESOLVER_ARN: patient360Stack.identityResolverFunction.functionArn,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadData(this.lexFulfillmentFunction);
    foundationStack.conversationTable.grantReadWriteData(this.lexFulfillmentFunction);
    foundationStack.appointmentTable.grantReadWriteData(this.lexFulfillmentFunction);
    foundationStack.eventBus.grantPutEventsTo(this.lexFulfillmentFunction);
    this.bedrockConversationFunction.grantInvoke(this.lexFulfillmentFunction);
    this.appointmentSchedulerFunction.grantInvoke(this.lexFulfillmentFunction);
    this.contextBuilderFunction.grantInvoke(this.lexFulfillmentFunction);
    patient360Stack.identityResolverFunction.grantInvoke(this.lexFulfillmentFunction);

    // Lex V2 permissions
    this.lexFulfillmentFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'lex:RecognizeText',
        'lex:RecognizeUtterance',
        'lex:PutSession',
        'lex:GetSession',
        'lex:DeleteSession',
      ],
      resources: [`arn:aws:lex:${this.region}:${this.account}:bot-alias/*`],
    }));

    // ========================================================================
    // Interactive Message Lambda
    // Creates interactive messages for Apple Messages for Business
    // (Time Picker, List Picker, Rich Links, etc.)
    // ========================================================================
    this.interactiveMessageFunction = new nodejs.NodejsFunction(this, 'InteractiveMessage', {
      functionName: `medcx-${envName}-interactive-message`,
      entry: path.join(__dirname, '../../../lambdas/genai/interactive-message.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        APPOINTMENT_SCHEDULER_ARN: this.appointmentSchedulerFunction.functionArn,
        OUTBOUND_QUEUE_URL: omnichannelStack.outboundMessageQueue.queueUrl,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadData(this.interactiveMessageFunction);
    foundationStack.appointmentTable.grantReadData(this.interactiveMessageFunction);
    foundationStack.conversationTable.grantReadWriteData(this.interactiveMessageFunction);
    foundationStack.eventBus.grantPutEventsTo(this.interactiveMessageFunction);
    this.appointmentSchedulerFunction.grantInvoke(this.interactiveMessageFunction);
    omnichannelStack.outboundMessageQueue.grantSendMessages(this.interactiveMessageFunction);

    // ========================================================================
    // GenAI API Gateway
    // ========================================================================
    this.genaiApi = new apigateway.RestApi(this, 'GenAIApi', {
      restApiName: `medcx-${envName}-genai-api`,
      description: 'GenAI and scheduling API for CloudWest MedCX',
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

    // Conversation endpoint (for direct API access to GenAI)
    const conversationResource = this.genaiApi.root.addResource('conversation');
    conversationResource.addMethod('POST', new apigateway.LambdaIntegration(this.bedrockConversationFunction), {
      apiKeyRequired: true,
    });

    // Appointment scheduling endpoints
    const appointmentsResource = this.genaiApi.root.addResource('appointments');

    // Get available slots
    const slotsResource = appointmentsResource.addResource('slots');
    slotsResource.addMethod('GET', new apigateway.LambdaIntegration(this.appointmentSchedulerFunction), {
      apiKeyRequired: true,
    });

    // Schedule appointment
    appointmentsResource.addMethod('POST', new apigateway.LambdaIntegration(this.appointmentSchedulerFunction), {
      apiKeyRequired: true,
    });

    // Reschedule/cancel appointment
    const appointmentByIdResource = appointmentsResource.addResource('{appointmentId}');
    appointmentByIdResource.addMethod('PUT', new apigateway.LambdaIntegration(this.appointmentSchedulerFunction), {
      apiKeyRequired: true,
    });
    appointmentByIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(this.appointmentSchedulerFunction), {
      apiKeyRequired: true,
    });

    // Interactive message creation
    const interactiveResource = this.genaiApi.root.addResource('interactive');

    // Time picker
    const timePickerResource = interactiveResource.addResource('time-picker');
    timePickerResource.addMethod('POST', new apigateway.LambdaIntegration(this.interactiveMessageFunction), {
      apiKeyRequired: true,
    });

    // List picker
    const listPickerResource = interactiveResource.addResource('list-picker');
    listPickerResource.addMethod('POST', new apigateway.LambdaIntegration(this.interactiveMessageFunction), {
      apiKeyRequired: true,
    });

    // Lex webhook (for Connect integration)
    const lexResource = this.genaiApi.root.addResource('lex');
    lexResource.addMethod('POST', new apigateway.LambdaIntegration(this.lexFulfillmentFunction));

    // API Key
    const apiKey = this.genaiApi.addApiKey('GenAIApiKey', {
      apiKeyName: `medcx-${envName}-genai-api-key`,
    });

    const usagePlan = this.genaiApi.addUsagePlan('GenAIApiUsagePlan', {
      name: `medcx-${envName}-genai-usage-plan`,
      throttle: {
        rateLimit: 100,
        burstLimit: 200,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.genaiApi.deploymentStage });

    // ========================================================================
    // EventBridge Rules
    // ========================================================================

    // Route appointment-related events to scheduler
    new events.Rule(this, 'AppointmentEventRule', {
      ruleName: `medcx-${envName}-appointment-events`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.appointments'],
        detailType: ['AppointmentRequested', 'AppointmentRescheduleRequested', 'AppointmentCancelRequested'],
      },
      targets: [new targets.LambdaFunction(this.appointmentSchedulerFunction)],
    });

    // Route conversation events that need AI processing
    new events.Rule(this, 'AIConversationRule', {
      ruleName: `medcx-${envName}-ai-conversation`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.conversations'],
        detailType: ['InboundMessageReceived'],
        detail: {
          requiresAI: [true],
        },
      },
      targets: [new targets.LambdaFunction(this.bedrockConversationFunction)],
    });

    // Route interactive message requests
    new events.Rule(this, 'InteractiveMessageRule', {
      ruleName: `medcx-${envName}-interactive-message`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.genai'],
        detailType: ['InteractiveMessageRequested'],
      },
      targets: [new targets.LambdaFunction(this.interactiveMessageFunction)],
    });

    // ========================================================================
    // CloudWatch Log Groups
    // ========================================================================
    new logs.LogGroup(this, 'GenAILogs', {
      logGroupName: `/medcx/${envName}/genai`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new logs.LogGroup(this, 'LexConversationLogs', {
      logGroupName: `/medcx/${envName}/lex-conversations`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'GenAIApiUrl', {
      value: this.genaiApi.url,
      description: 'GenAI API URL',
      exportName: `medcx-${envName}-genai-api-url`,
    });

    new cdk.CfnOutput(this, 'LexFulfillmentArn', {
      value: this.lexFulfillmentFunction.functionArn,
      description: 'Lex Fulfillment Lambda ARN (use in Lex bot configuration)',
      exportName: `medcx-${envName}-lex-fulfillment-arn`,
    });

    new cdk.CfnOutput(this, 'BedrockConversationArn', {
      value: this.bedrockConversationFunction.functionArn,
      description: 'Bedrock Conversation Lambda ARN',
      exportName: `medcx-${envName}-bedrock-conversation-arn`,
    });

    new cdk.CfnOutput(this, 'AppointmentSchedulerArn', {
      value: this.appointmentSchedulerFunction.functionArn,
      description: 'Appointment Scheduler Lambda ARN',
      exportName: `medcx-${envName}-appointment-scheduler-arn`,
    });

    new cdk.CfnOutput(this, 'InteractiveMessageArn', {
      value: this.interactiveMessageFunction.functionArn,
      description: 'Interactive Message Lambda ARN',
      exportName: `medcx-${envName}-interactive-message-arn`,
    });
  }
}
