import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { Phase1FoundationStack } from '../phase1-foundation/foundation-stack';
import * as path from 'path';

export interface Phase2Patient360StackProps extends cdk.StackProps {
  envName: string;
  foundationStack: Phase1FoundationStack;
}

export class Phase2Patient360Stack extends cdk.Stack {
  public readonly patientApi: apigateway.RestApi;
  public readonly identityResolverFunction: lambda.Function;
  public readonly patientServiceFunction: lambda.Function;
  public readonly conversationManagerFunction: lambda.Function;
  public readonly careFollowupStateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: Phase2Patient360StackProps) {
    super(scope, id, props);

    const { envName, foundationStack } = props;

    // ========================================================================
    // Lambda Layer for shared utilities
    // ========================================================================
    const sharedLayer = new lambda.LayerVersion(this, 'SharedLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../lambdas/layers/shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared utilities for MedCX Lambda functions',
    });

    // Common Lambda environment variables
    const commonEnvVars = {
      PATIENT_TABLE: foundationStack.patientTable.tableName,
      CONVERSATION_TABLE: foundationStack.conversationTable.tableName,
      APPOINTMENT_TABLE: foundationStack.appointmentTable.tableName,
      INTERACTION_TABLE: foundationStack.interactionTable.tableName,
      EVENT_BUS_NAME: foundationStack.eventBus.eventBusName,
      ENVIRONMENT: envName,
    };

    // ========================================================================
    // Identity Resolver Lambda
    // Resolves patient identity from phone number, email, or external ID
    // ========================================================================
    this.identityResolverFunction = new nodejs.NodejsFunction(this, 'IdentityResolver', {
      functionName: `medcx-${envName}-identity-resolver`,
      entry: path.join(__dirname, '../../../lambdas/patient-service/identity-resolver.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadWriteData(this.identityResolverFunction);
    foundationStack.eventBus.grantPutEventsTo(this.identityResolverFunction);

    // ========================================================================
    // Patient Service Lambda
    // CRUD operations for patient profiles
    // ========================================================================
    this.patientServiceFunction = new nodejs.NodejsFunction(this, 'PatientService', {
      functionName: `medcx-${envName}-patient-service`,
      entry: path.join(__dirname, '../../../lambdas/patient-service/patient-service.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        DOCUMENTS_BUCKET: foundationStack.documentsBucket.bucketName,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadWriteData(this.patientServiceFunction);
    foundationStack.interactionTable.grantReadWriteData(this.patientServiceFunction);
    foundationStack.documentsBucket.grantReadWrite(this.patientServiceFunction);
    foundationStack.eventBus.grantPutEventsTo(this.patientServiceFunction);

    // ========================================================================
    // Conversation Manager Lambda
    // Manages unified conversation threads across channels
    // ========================================================================
    this.conversationManagerFunction = new nodejs.NodejsFunction(this, 'ConversationManager', {
      functionName: `medcx-${envName}-conversation-manager`,
      entry: path.join(__dirname, '../../../lambdas/conversation-manager/conversation-manager.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.conversationTable.grantReadWriteData(this.conversationManagerFunction);
    foundationStack.patientTable.grantReadData(this.conversationManagerFunction);
    foundationStack.interactionTable.grantReadWriteData(this.conversationManagerFunction);
    foundationStack.eventBus.grantPutEventsTo(this.conversationManagerFunction);

    // ========================================================================
    // Patient 360 API Gateway
    // ========================================================================
    this.patientApi = new apigateway.RestApi(this, 'PatientApi', {
      restApiName: `medcx-${envName}-patient-api`,
      description: 'Patient 360 API for CloudWest MedCX',
      deployOptions: {
        stageName: envName,
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
      },
    });

    // API Key for external integrations
    const apiKey = this.patientApi.addApiKey('PatientApiKey', {
      apiKeyName: `medcx-${envName}-patient-api-key`,
      description: 'API key for Patient 360 API',
    });

    const usagePlan = this.patientApi.addUsagePlan('PatientApiUsagePlan', {
      name: `medcx-${envName}-patient-api-usage-plan`,
      throttle: {
        rateLimit: 1000,
        burstLimit: 2000,
      },
      quota: {
        limit: 100000,
        period: apigateway.Period.DAY,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.patientApi.deploymentStage });

    // ========================================================================
    // API Resources and Methods
    // ========================================================================

    // Identity resolution endpoint
    const identityResource = this.patientApi.root.addResource('identity');
    const resolveResource = identityResource.addResource('resolve');

    resolveResource.addMethod('POST', new apigateway.LambdaIntegration(this.identityResolverFunction), {
      apiKeyRequired: true,
    });

    // Patient CRUD endpoints
    const patientsResource = this.patientApi.root.addResource('patients');

    patientsResource.addMethod('POST', new apigateway.LambdaIntegration(this.patientServiceFunction), {
      apiKeyRequired: true,
    });

    patientsResource.addMethod('GET', new apigateway.LambdaIntegration(this.patientServiceFunction), {
      apiKeyRequired: true,
    });

    const patientByIdResource = patientsResource.addResource('{patientId}');

    patientByIdResource.addMethod('GET', new apigateway.LambdaIntegration(this.patientServiceFunction), {
      apiKeyRequired: true,
    });

    patientByIdResource.addMethod('PUT', new apigateway.LambdaIntegration(this.patientServiceFunction), {
      apiKeyRequired: true,
    });

    // Patient 360 view endpoint
    const patient360Resource = patientByIdResource.addResource('360');
    patient360Resource.addMethod('GET', new apigateway.LambdaIntegration(this.patientServiceFunction), {
      apiKeyRequired: true,
    });

    // Conversation endpoints
    const conversationsResource = this.patientApi.root.addResource('conversations');

    conversationsResource.addMethod('POST', new apigateway.LambdaIntegration(this.conversationManagerFunction), {
      apiKeyRequired: true,
    });

    const patientConversationsResource = patientByIdResource.addResource('conversations');
    patientConversationsResource.addMethod('GET', new apigateway.LambdaIntegration(this.conversationManagerFunction), {
      apiKeyRequired: true,
    });

    // Note: Using conversations resource with threadId for individual conversation access
    // Using the conversations resource with query params instead
    const conversationByIdResource = conversationsResource.addResource('{threadId}');

    conversationByIdResource.addMethod('GET', new apigateway.LambdaIntegration(this.conversationManagerFunction), {
      apiKeyRequired: true,
    });

    // Message to conversation
    const messagesResource = conversationByIdResource.addResource('messages');
    messagesResource.addMethod('POST', new apigateway.LambdaIntegration(this.conversationManagerFunction), {
      apiKeyRequired: true,
    });

    // ========================================================================
    // Care Follow-up State Machine
    // Automated patient care follow-ups
    // ========================================================================

    // Lambda for sending follow-up messages
    const followupSenderFunction = new nodejs.NodejsFunction(this, 'FollowupSender', {
      functionName: `medcx-${envName}-followup-sender`,
      entry: path.join(__dirname, '../../../lambdas/patient-service/followup-sender.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    foundationStack.patientTable.grantReadData(followupSenderFunction);
    foundationStack.conversationTable.grantReadWriteData(followupSenderFunction);
    foundationStack.eventBus.grantPutEventsTo(followupSenderFunction);

    // Lambda for checking patient response
    const responseCheckerFunction = new nodejs.NodejsFunction(this, 'ResponseChecker', {
      functionName: `medcx-${envName}-response-checker`,
      entry: path.join(__dirname, '../../../lambdas/patient-service/response-checker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    foundationStack.conversationTable.grantReadData(responseCheckerFunction);

    // Define the state machine
    const sendFollowup = new tasks.LambdaInvoke(this, 'SendFollowup', {
      lambdaFunction: followupSenderFunction,
      outputPath: '$.Payload',
    });

    const waitForResponse = new stepfunctions.Wait(this, 'WaitForResponse', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.hours(24)),
    });

    const checkResponse = new tasks.LambdaInvoke(this, 'CheckResponse', {
      lambdaFunction: responseCheckerFunction,
      outputPath: '$.Payload',
    });

    const escalateToAgent = new stepfunctions.Pass(this, 'EscalateToAgent', {
      result: stepfunctions.Result.fromObject({ action: 'escalate' }),
    });

    const followupComplete = new stepfunctions.Pass(this, 'FollowupComplete', {
      result: stepfunctions.Result.fromObject({ action: 'complete' }),
    });

    const retryCount = new stepfunctions.Choice(this, 'RetryCount')
      .when(
        stepfunctions.Condition.numberLessThan('$.retryCount', 3),
        sendFollowup
      )
      .otherwise(escalateToAgent);

    const hasResponded = new stepfunctions.Choice(this, 'HasResponded')
      .when(
        stepfunctions.Condition.booleanEquals('$.responded', true),
        followupComplete
      )
      .otherwise(retryCount);

    const definition = sendFollowup
      .next(waitForResponse)
      .next(checkResponse)
      .next(hasResponded);

    this.careFollowupStateMachine = new stepfunctions.StateMachine(this, 'CareFollowupStateMachine', {
      stateMachineName: `medcx-${envName}-care-followup`,
      definition,
      timeout: cdk.Duration.days(7),
      tracingEnabled: true,
    });

    // ========================================================================
    // EventBridge Rules
    // ========================================================================

    // Trigger follow-up after appointment completion
    new events.Rule(this, 'AppointmentCompletedRule', {
      ruleName: `medcx-${envName}-appointment-completed`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.appointments'],
        detailType: ['AppointmentCompleted'],
      },
      targets: [new targets.SfnStateMachine(this.careFollowupStateMachine)],
    });

    // Process new patient registrations
    new events.Rule(this, 'PatientRegisteredRule', {
      ruleName: `medcx-${envName}-patient-registered`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.patients'],
        detailType: ['PatientRegistered'],
      },
      targets: [new targets.LambdaFunction(this.patientServiceFunction)],
    });

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'PatientApiUrl', {
      value: this.patientApi.url,
      description: 'Patient 360 API URL',
      exportName: `medcx-${envName}-patient-api-url`,
    });

    new cdk.CfnOutput(this, 'PatientApiKeyId', {
      value: apiKey.keyId,
      description: 'Patient API Key ID',
      exportName: `medcx-${envName}-patient-api-key-id`,
    });

    new cdk.CfnOutput(this, 'IdentityResolverArn', {
      value: this.identityResolverFunction.functionArn,
      description: 'Identity Resolver Lambda ARN',
      exportName: `medcx-${envName}-identity-resolver-arn`,
    });

    new cdk.CfnOutput(this, 'ConversationManagerArn', {
      value: this.conversationManagerFunction.functionArn,
      description: 'Conversation Manager Lambda ARN',
      exportName: `medcx-${envName}-conversation-manager-arn`,
    });
  }
}
