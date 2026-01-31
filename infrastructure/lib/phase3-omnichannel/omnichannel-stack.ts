import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Phase1FoundationStack } from '../phase1-foundation/foundation-stack';
import { Phase2Patient360Stack } from '../phase2-patient360/patient360-stack';
import * as path from 'path';

export interface Phase3OmnichannelStackProps extends cdk.StackProps {
  envName: string;
  foundationStack: Phase1FoundationStack;
  patient360Stack: Phase2Patient360Stack;
}

export class Phase3OmnichannelStack extends cdk.Stack {
  public readonly channelRouterFunction: lambda.Function;
  public readonly smsHandlerFunction: lambda.Function;
  public readonly appleBusinessHandlerFunction: lambda.Function;
  public readonly voiceHandlerFunction: lambda.Function;
  public readonly channelHandoffFunction: lambda.Function;
  public readonly omnichannelApi: apigateway.RestApi;
  public readonly inboundMessageQueue: sqs.Queue;
  public readonly outboundMessageQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: Phase3OmnichannelStackProps) {
    super(scope, id, props);

    const { envName, foundationStack, patient360Stack } = props;

    // ========================================================================
    // SQS Queues for message processing
    // ========================================================================

    // Inbound message queue (messages from patients)
    this.inboundMessageQueue = new sqs.Queue(this, 'InboundMessageQueue', {
      queueName: `medcx-${envName}-inbound-messages`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: foundationStack.encryptionKey,
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: {
        queue: foundationStack.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // Outbound message queue (messages to patients)
    this.outboundMessageQueue = new sqs.Queue(this, 'OutboundMessageQueue', {
      queueName: `medcx-${envName}-outbound-messages`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: foundationStack.encryptionKey,
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: {
        queue: foundationStack.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // ========================================================================
    // Common Lambda environment variables
    // ========================================================================
    const commonEnvVars = {
      PATIENT_TABLE: foundationStack.patientTable.tableName,
      CONVERSATION_TABLE: foundationStack.conversationTable.tableName,
      INTERACTION_TABLE: foundationStack.interactionTable.tableName,
      EVENT_BUS_NAME: foundationStack.eventBus.eventBusName,
      INBOUND_QUEUE_URL: this.inboundMessageQueue.queueUrl,
      OUTBOUND_QUEUE_URL: this.outboundMessageQueue.queueUrl,
      APPLE_BUSINESS_SECRET_ARN: foundationStack.appleBusinessSecret.secretArn,
      ENVIRONMENT: envName,
    };

    // ========================================================================
    // Lambda Layer for shared utilities
    // ========================================================================
    const sharedLayer = new lambda.LayerVersion(this, 'OmnichannelSharedLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../lambdas/layers/shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared utilities for Omnichannel Lambda functions',
    });

    // ========================================================================
    // Channel Router Lambda
    // Routes incoming messages to appropriate handlers based on channel
    // ========================================================================
    this.channelRouterFunction = new nodejs.NodejsFunction(this, 'ChannelRouter', {
      functionName: `medcx-${envName}-channel-router`,
      entry: path.join(__dirname, '../../../lambdas/omnichannel/channel-router.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        IDENTITY_RESOLVER_ARN: patient360Stack.identityResolverFunction.functionArn,
        CONVERSATION_MANAGER_ARN: patient360Stack.conversationManagerFunction.functionArn,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadWriteData(this.channelRouterFunction);
    foundationStack.conversationTable.grantReadWriteData(this.channelRouterFunction);
    foundationStack.eventBus.grantPutEventsTo(this.channelRouterFunction);
    patient360Stack.identityResolverFunction.grantInvoke(this.channelRouterFunction);
    patient360Stack.conversationManagerFunction.grantInvoke(this.channelRouterFunction);
    this.inboundMessageQueue.grantConsumeMessages(this.channelRouterFunction);
    this.outboundMessageQueue.grantSendMessages(this.channelRouterFunction);

    // ========================================================================
    // SMS Handler Lambda (Amazon Pinpoint)
    // Handles SMS/MMS via Amazon Pinpoint
    // ========================================================================
    this.smsHandlerFunction = new nodejs.NodejsFunction(this, 'SmsHandler', {
      functionName: `medcx-${envName}-sms-handler`,
      entry: path.join(__dirname, '../../../lambdas/omnichannel/sms-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        PINPOINT_APPLICATION_ID: `medcx-${envName}-pinpoint`, // Will be created manually or via custom resource
        PINPOINT_ORIGINATION_NUMBER: process.env.PINPOINT_PHONE_NUMBER || '+15551234567',
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Pinpoint permissions
    this.smsHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'mobiletargeting:SendMessages',
        'mobiletargeting:SendUsersMessages',
        'mobiletargeting:GetEndpoint',
        'mobiletargeting:UpdateEndpoint',
        'mobiletargeting:PutEvents',
      ],
      resources: [`arn:aws:mobiletargeting:${this.region}:${this.account}:apps/*`],
    }));

    foundationStack.patientTable.grantReadData(this.smsHandlerFunction);
    foundationStack.conversationTable.grantReadWriteData(this.smsHandlerFunction);
    foundationStack.eventBus.grantPutEventsTo(this.smsHandlerFunction);
    this.outboundMessageQueue.grantConsumeMessages(this.smsHandlerFunction);

    // ========================================================================
    // Apple Messages for Business Handler Lambda
    // Handles Apple Messages for Business integration
    // ========================================================================
    this.appleBusinessHandlerFunction = new nodejs.NodejsFunction(this, 'AppleBusinessHandler', {
      functionName: `medcx-${envName}-apple-business-handler`,
      entry: path.join(__dirname, '../../../lambdas/omnichannel/apple-business-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        APPLE_BUSINESS_SECRET_ARN: foundationStack.appleBusinessSecret.secretArn,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.appleBusinessSecret.grantRead(this.appleBusinessHandlerFunction);
    foundationStack.patientTable.grantReadData(this.appleBusinessHandlerFunction);
    foundationStack.conversationTable.grantReadWriteData(this.appleBusinessHandlerFunction);
    foundationStack.eventBus.grantPutEventsTo(this.appleBusinessHandlerFunction);
    this.outboundMessageQueue.grantConsumeMessages(this.appleBusinessHandlerFunction);

    // ========================================================================
    // Voice Handler Lambda (Amazon Connect)
    // Handles voice interactions via Amazon Connect
    // ========================================================================
    this.voiceHandlerFunction = new nodejs.NodejsFunction(this, 'VoiceHandler', {
      functionName: `medcx-${envName}-voice-handler`,
      entry: path.join(__dirname, '../../../lambdas/omnichannel/voice-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        CONNECT_INSTANCE_ID: `medcx-${envName}-connect`, // Will be set after Connect instance creation
        RECORDINGS_BUCKET: foundationStack.recordingsBucket.bucketName,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Connect permissions
    this.voiceHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'connect:GetContactAttributes',
        'connect:UpdateContactAttributes',
        'connect:StartOutboundVoiceContact',
        'connect:StopContact',
        'connect:DescribeContact',
        'connect:ListQueues',
        'connect:ListContactFlows',
      ],
      resources: [`arn:aws:connect:${this.region}:${this.account}:instance/*`],
    }));

    foundationStack.patientTable.grantReadData(this.voiceHandlerFunction);
    foundationStack.conversationTable.grantReadWriteData(this.voiceHandlerFunction);
    foundationStack.interactionTable.grantReadWriteData(this.voiceHandlerFunction);
    foundationStack.recordingsBucket.grantReadWrite(this.voiceHandlerFunction);
    foundationStack.eventBus.grantPutEventsTo(this.voiceHandlerFunction);

    // ========================================================================
    // Channel Handoff Lambda
    // Manages seamless handoffs between channels
    // ========================================================================
    this.channelHandoffFunction = new nodejs.NodejsFunction(this, 'ChannelHandoff', {
      functionName: `medcx-${envName}-channel-handoff`,
      entry: path.join(__dirname, '../../../lambdas/omnichannel/channel-handoff.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        SMS_HANDLER_ARN: this.smsHandlerFunction.functionArn,
        APPLE_HANDLER_ARN: this.appleBusinessHandlerFunction.functionArn,
        VOICE_HANDLER_ARN: this.voiceHandlerFunction.functionArn,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadData(this.channelHandoffFunction);
    foundationStack.conversationTable.grantReadWriteData(this.channelHandoffFunction);
    foundationStack.eventBus.grantPutEventsTo(this.channelHandoffFunction);
    this.smsHandlerFunction.grantInvoke(this.channelHandoffFunction);
    this.appleBusinessHandlerFunction.grantInvoke(this.channelHandoffFunction);
    this.voiceHandlerFunction.grantInvoke(this.channelHandoffFunction);

    // ========================================================================
    // Omnichannel API Gateway
    // ========================================================================
    this.omnichannelApi = new apigateway.RestApi(this, 'OmnichannelApi', {
      restApiName: `medcx-${envName}-omnichannel-api`,
      description: 'Omnichannel messaging API for CloudWest MedCX',
      deployOptions: {
        stageName: envName,
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Apple-Business-Signature'],
      },
    });

    // Webhook endpoints for each channel
    const webhooksResource = this.omnichannelApi.root.addResource('webhooks');

    // Pinpoint SMS webhook
    const smsWebhook = webhooksResource.addResource('sms');
    smsWebhook.addMethod('POST', new apigateway.LambdaIntegration(this.channelRouterFunction));

    // Apple Messages for Business webhook
    const appleWebhook = webhooksResource.addResource('apple');
    appleWebhook.addMethod('POST', new apigateway.LambdaIntegration(this.channelRouterFunction));

    // Amazon Connect contact flow webhook
    const connectWebhook = webhooksResource.addResource('connect');
    connectWebhook.addMethod('POST', new apigateway.LambdaIntegration(this.voiceHandlerFunction));

    // Send message endpoint
    const sendResource = this.omnichannelApi.root.addResource('send');
    sendResource.addMethod('POST', new apigateway.LambdaIntegration(this.channelRouterFunction), {
      apiKeyRequired: true,
    });

    // Channel handoff endpoint
    const handoffResource = this.omnichannelApi.root.addResource('handoff');
    handoffResource.addMethod('POST', new apigateway.LambdaIntegration(this.channelHandoffFunction), {
      apiKeyRequired: true,
    });

    // API Key
    const apiKey = this.omnichannelApi.addApiKey('OmnichannelApiKey', {
      apiKeyName: `medcx-${envName}-omnichannel-api-key`,
    });

    const usagePlan = this.omnichannelApi.addUsagePlan('OmnichannelApiUsagePlan', {
      name: `medcx-${envName}-omnichannel-usage-plan`,
      throttle: {
        rateLimit: 500,
        burstLimit: 1000,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.omnichannelApi.deploymentStage });

    // ========================================================================
    // EventBridge Rules
    // ========================================================================

    // Route followup messages to appropriate channel
    new events.Rule(this, 'FollowupMessageRule', {
      ruleName: `medcx-${envName}-followup-message`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.followups'],
        detailType: ['FollowupMessageReady'],
      },
      targets: [new targets.LambdaFunction(this.channelRouterFunction)],
    });

    // Route channel handoff requests
    new events.Rule(this, 'ChannelHandoffRule', {
      ruleName: `medcx-${envName}-channel-handoff`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.conversations'],
        detailType: ['ChannelHandoffRequested'],
      },
      targets: [new targets.LambdaFunction(this.channelHandoffFunction)],
    });

    // ========================================================================
    // SQS Event Sources
    // ========================================================================

    // Process inbound messages from queue
    this.channelRouterFunction.addEventSourceMapping('InboundQueueMapping', {
      eventSourceArn: this.inboundMessageQueue.queueArn,
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(5),
    });

    // Process outbound messages from queue (SMS)
    this.smsHandlerFunction.addEventSourceMapping('OutboundSmsQueueMapping', {
      eventSourceArn: this.outboundMessageQueue.queueArn,
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(5),
      filterCriteria: lambda.FilterCriteria.filter({
        body: {
          channel: lambda.FilterRule.isEqual('sms'),
        },
      }),
    });

    // Process outbound messages from queue (Apple)
    this.appleBusinessHandlerFunction.addEventSourceMapping('OutboundAppleQueueMapping', {
      eventSourceArn: this.outboundMessageQueue.queueArn,
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(5),
      filterCriteria: lambda.FilterCriteria.filter({
        body: {
          channel: lambda.FilterRule.isEqual('apple_business'),
        },
      }),
    });

    // ========================================================================
    // CloudWatch Log Groups
    // ========================================================================
    new logs.LogGroup(this, 'OmnichannelLogs', {
      logGroupName: `/medcx/${envName}/omnichannel`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'OmnichannelApiUrl', {
      value: this.omnichannelApi.url,
      description: 'Omnichannel API URL',
      exportName: `medcx-${envName}-omnichannel-api-url`,
    });

    new cdk.CfnOutput(this, 'SmsWebhookUrl', {
      value: `${this.omnichannelApi.url}webhooks/sms`,
      description: 'SMS webhook URL for Pinpoint',
      exportName: `medcx-${envName}-sms-webhook-url`,
    });

    new cdk.CfnOutput(this, 'AppleWebhookUrl', {
      value: `${this.omnichannelApi.url}webhooks/apple`,
      description: 'Apple Messages for Business webhook URL',
      exportName: `medcx-${envName}-apple-webhook-url`,
    });

    new cdk.CfnOutput(this, 'ConnectWebhookUrl', {
      value: `${this.omnichannelApi.url}webhooks/connect`,
      description: 'Amazon Connect webhook URL',
      exportName: `medcx-${envName}-connect-webhook-url`,
    });

    new cdk.CfnOutput(this, 'ChannelRouterArn', {
      value: this.channelRouterFunction.functionArn,
      description: 'Channel Router Lambda ARN',
      exportName: `medcx-${envName}-channel-router-arn`,
    });

    new cdk.CfnOutput(this, 'InboundQueueUrl', {
      value: this.inboundMessageQueue.queueUrl,
      description: 'Inbound message queue URL',
      exportName: `medcx-${envName}-inbound-queue-url`,
    });

    new cdk.CfnOutput(this, 'OutboundQueueUrl', {
      value: this.outboundMessageQueue.queueUrl,
      description: 'Outbound message queue URL',
      exportName: `medcx-${envName}-outbound-queue-url`,
    });
  }
}
