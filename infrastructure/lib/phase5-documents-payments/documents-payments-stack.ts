import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { Phase1FoundationStack } from '../phase1-foundation/foundation-stack';
import { Phase2Patient360Stack } from '../phase2-patient360/patient360-stack';
import * as path from 'path';

export interface Phase5DocumentsPaymentsStackProps extends cdk.StackProps {
  envName: string;
  foundationStack: Phase1FoundationStack;
  patient360Stack: Phase2Patient360Stack;
}

export class Phase5DocumentsPaymentsStack extends cdk.Stack {
  public readonly documentProcessorFunction: lambda.Function;
  public readonly insuranceVerifierFunction: lambda.Function;
  public readonly idVerifierFunction: lambda.Function;
  public readonly paymentProcessorFunction: lambda.Function;
  public readonly paymentWebhookFunction: lambda.Function;
  public readonly documentProcessingStateMachine: stepfunctions.StateMachine;
  public readonly documentsPaymentsApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: Phase5DocumentsPaymentsStackProps) {
    super(scope, id, props);

    const { envName, foundationStack, patient360Stack } = props;

    // ========================================================================
    // Common Lambda environment variables
    // ========================================================================
    const commonEnvVars = {
      PATIENT_TABLE: foundationStack.patientTable.tableName,
      DOCUMENTS_BUCKET: foundationStack.documentsBucket.bucketName,
      EVENT_BUS_NAME: foundationStack.eventBus.eventBusName,
      STRIPE_SECRET_ARN: foundationStack.stripeSecret.secretArn,
      ENVIRONMENT: envName,
    };

    // ========================================================================
    // Lambda Layer for shared utilities
    // ========================================================================
    const sharedLayer = new lambda.LayerVersion(this, 'DocumentsPaymentsSharedLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../lambdas/layers/shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared utilities for Documents and Payments Lambda functions',
    });

    // ========================================================================
    // Document Processor Lambda
    // Processes uploaded documents using Amazon Textract
    // ========================================================================
    this.documentProcessorFunction = new nodejs.NodejsFunction(this, 'DocumentProcessor', {
      functionName: `medcx-${envName}-document-processor`,
      entry: path.join(__dirname, '../../../lambdas/documents/document-processor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        ...commonEnvVars,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Textract permissions
    this.documentProcessorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'textract:AnalyzeDocument',
        'textract:AnalyzeExpense',
        'textract:AnalyzeID',
        'textract:DetectDocumentText',
        'textract:StartDocumentAnalysis',
        'textract:GetDocumentAnalysis',
        'textract:StartExpenseAnalysis',
        'textract:GetExpenseAnalysis',
      ],
      resources: ['*'],
    }));

    foundationStack.documentsBucket.grantReadWrite(this.documentProcessorFunction);
    foundationStack.patientTable.grantReadWriteData(this.documentProcessorFunction);
    foundationStack.eventBus.grantPutEventsTo(this.documentProcessorFunction);

    // ========================================================================
    // Insurance Verifier Lambda
    // Extracts and validates insurance card information
    // ========================================================================
    this.insuranceVerifierFunction = new nodejs.NodejsFunction(this, 'InsuranceVerifier', {
      functionName: `medcx-${envName}-insurance-verifier`,
      entry: path.join(__dirname, '../../../lambdas/documents/insurance-verifier.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Textract permissions for expense analysis (insurance cards)
    this.insuranceVerifierFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'textract:AnalyzeDocument',
        'textract:AnalyzeExpense',
      ],
      resources: ['*'],
    }));

    foundationStack.documentsBucket.grantRead(this.insuranceVerifierFunction);
    foundationStack.patientTable.grantReadWriteData(this.insuranceVerifierFunction);
    foundationStack.eventBus.grantPutEventsTo(this.insuranceVerifierFunction);

    // ========================================================================
    // ID Verifier Lambda
    // Extracts and validates government ID information
    // ========================================================================
    this.idVerifierFunction = new nodejs.NodejsFunction(this, 'IdVerifier', {
      functionName: `medcx-${envName}-id-verifier`,
      entry: path.join(__dirname, '../../../lambdas/documents/id-verifier.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Textract AnalyzeID permissions
    this.idVerifierFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'textract:AnalyzeID',
        'textract:AnalyzeDocument',
      ],
      resources: ['*'],
    }));

    foundationStack.documentsBucket.grantRead(this.idVerifierFunction);
    foundationStack.patientTable.grantReadWriteData(this.idVerifierFunction);
    foundationStack.eventBus.grantPutEventsTo(this.idVerifierFunction);

    // ========================================================================
    // Payment Processor Lambda
    // Handles payment processing via Stripe
    // ========================================================================
    this.paymentProcessorFunction = new nodejs.NodejsFunction(this, 'PaymentProcessor', {
      functionName: `medcx-${envName}-payment-processor`,
      entry: path.join(__dirname, '../../../lambdas/payments/payment-processor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ...commonEnvVars,
        STRIPE_SECRET_ARN: foundationStack.stripeSecret.secretArn,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.stripeSecret.grantRead(this.paymentProcessorFunction);
    foundationStack.patientTable.grantReadWriteData(this.paymentProcessorFunction);
    foundationStack.eventBus.grantPutEventsTo(this.paymentProcessorFunction);

    // ========================================================================
    // Payment Webhook Lambda
    // Handles Stripe webhook events
    // ========================================================================
    this.paymentWebhookFunction = new nodejs.NodejsFunction(this, 'PaymentWebhook', {
      functionName: `medcx-${envName}-payment-webhook`,
      entry: path.join(__dirname, '../../../lambdas/payments/payment-webhook.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...commonEnvVars,
        STRIPE_SECRET_ARN: foundationStack.stripeSecret.secretArn,
      },
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.stripeSecret.grantRead(this.paymentWebhookFunction);
    foundationStack.patientTable.grantReadWriteData(this.paymentWebhookFunction);
    foundationStack.eventBus.grantPutEventsTo(this.paymentWebhookFunction);

    // ========================================================================
    // Document Processing State Machine
    // Orchestrates document processing workflow
    // ========================================================================

    // Step 1: Process document
    const processDocument = new tasks.LambdaInvoke(this, 'ProcessDocument', {
      lambdaFunction: this.documentProcessorFunction,
      outputPath: '$.Payload',
    });

    // Step 2: Determine document type
    const determineDocumentType = new stepfunctions.Choice(this, 'DetermineDocumentType');

    // Step 3a: Verify insurance card
    const verifyInsurance = new tasks.LambdaInvoke(this, 'VerifyInsurance', {
      lambdaFunction: this.insuranceVerifierFunction,
      outputPath: '$.Payload',
    });

    // Step 3b: Verify ID
    const verifyId = new tasks.LambdaInvoke(this, 'VerifyId', {
      lambdaFunction: this.idVerifierFunction,
      outputPath: '$.Payload',
    });

    // Step 3c: General document processing
    const processGenericDocument = new stepfunctions.Pass(this, 'ProcessGenericDocument', {
      result: stepfunctions.Result.fromObject({ status: 'processed', type: 'generic' }),
    });

    // Success state
    const documentProcessed = new stepfunctions.Pass(this, 'DocumentProcessed', {
      result: stepfunctions.Result.fromObject({ status: 'complete' }),
    });

    // Error handling
    const documentError = new stepfunctions.Pass(this, 'DocumentError', {
      result: stepfunctions.Result.fromObject({ status: 'error' }),
    });

    // Build state machine
    determineDocumentType
      .when(
        stepfunctions.Condition.stringEquals('$.documentType', 'INSURANCE_CARD'),
        verifyInsurance.next(documentProcessed)
      )
      .when(
        stepfunctions.Condition.stringEquals('$.documentType', 'GOVERNMENT_ID'),
        verifyId.next(documentProcessed)
      )
      .otherwise(processGenericDocument.next(documentProcessed));

    const definition = processDocument
      .addCatch(documentError)
      .next(determineDocumentType);

    this.documentProcessingStateMachine = new stepfunctions.StateMachine(this, 'DocumentProcessingStateMachine', {
      stateMachineName: `medcx-${envName}-document-processing`,
      definition,
      timeout: cdk.Duration.minutes(10),
      tracingEnabled: true,
    });

    // Grant state machine permissions
    this.documentProcessorFunction.grantInvoke(this.documentProcessingStateMachine);
    this.insuranceVerifierFunction.grantInvoke(this.documentProcessingStateMachine);
    this.idVerifierFunction.grantInvoke(this.documentProcessingStateMachine);

    // ========================================================================
    // S3 Event Notifications
    // ========================================================================

    // Trigger document processing when files are uploaded
    foundationStack.documentsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.documentProcessorFunction),
      { prefix: 'uploads/' }
    );

    // ========================================================================
    // Documents & Payments API Gateway
    // ========================================================================
    this.documentsPaymentsApi = new apigateway.RestApi(this, 'DocumentsPaymentsApi', {
      restApiName: `medcx-${envName}-documents-payments-api`,
      description: 'Documents and Payments API for CloudWest MedCX',
      deployOptions: {
        stageName: envName,
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'Stripe-Signature'],
      },
      binaryMediaTypes: ['image/*', 'application/pdf'],
    });

    // Document endpoints
    const documentsResource = this.documentsPaymentsApi.root.addResource('documents');

    // Get upload URL
    const uploadUrlResource = documentsResource.addResource('upload-url');
    uploadUrlResource.addMethod('POST', new apigateway.LambdaIntegration(this.documentProcessorFunction), {
      apiKeyRequired: true,
    });

    // Process document manually
    documentsResource.addMethod('POST', new apigateway.LambdaIntegration(this.documentProcessorFunction), {
      apiKeyRequired: true,
    });

    // Get document status
    const documentByIdResource = documentsResource.addResource('{documentId}');
    documentByIdResource.addMethod('GET', new apigateway.LambdaIntegration(this.documentProcessorFunction), {
      apiKeyRequired: true,
    });

    // Insurance verification
    const insuranceResource = documentsResource.addResource('insurance');
    insuranceResource.addMethod('POST', new apigateway.LambdaIntegration(this.insuranceVerifierFunction), {
      apiKeyRequired: true,
    });

    // ID verification
    const idResource = documentsResource.addResource('id');
    idResource.addMethod('POST', new apigateway.LambdaIntegration(this.idVerifierFunction), {
      apiKeyRequired: true,
    });

    // Payment endpoints
    const paymentsResource = this.documentsPaymentsApi.root.addResource('payments');

    // Create payment intent
    const intentResource = paymentsResource.addResource('intent');
    intentResource.addMethod('POST', new apigateway.LambdaIntegration(this.paymentProcessorFunction), {
      apiKeyRequired: true,
    });

    // Process payment
    paymentsResource.addMethod('POST', new apigateway.LambdaIntegration(this.paymentProcessorFunction), {
      apiKeyRequired: true,
    });

    // Get payment status
    const paymentByIdResource = paymentsResource.addResource('{paymentId}');
    paymentByIdResource.addMethod('GET', new apigateway.LambdaIntegration(this.paymentProcessorFunction), {
      apiKeyRequired: true,
    });

    // Refund payment
    const refundResource = paymentByIdResource.addResource('refund');
    refundResource.addMethod('POST', new apigateway.LambdaIntegration(this.paymentProcessorFunction), {
      apiKeyRequired: true,
    });

    // Patient payment history
    const patientPaymentsResource = paymentsResource.addResource('patient').addResource('{patientId}');
    patientPaymentsResource.addMethod('GET', new apigateway.LambdaIntegration(this.paymentProcessorFunction), {
      apiKeyRequired: true,
    });

    // Stripe webhook (no API key required - validated by Stripe signature)
    const webhookResource = paymentsResource.addResource('webhook');
    webhookResource.addMethod('POST', new apigateway.LambdaIntegration(this.paymentWebhookFunction));

    // Payment link generation
    const paymentLinkResource = paymentsResource.addResource('link');
    paymentLinkResource.addMethod('POST', new apigateway.LambdaIntegration(this.paymentProcessorFunction), {
      apiKeyRequired: true,
    });

    // API Key
    const apiKey = this.documentsPaymentsApi.addApiKey('DocumentsPaymentsApiKey', {
      apiKeyName: `medcx-${envName}-documents-payments-api-key`,
    });

    const usagePlan = this.documentsPaymentsApi.addUsagePlan('DocumentsPaymentsApiUsagePlan', {
      name: `medcx-${envName}-documents-payments-usage-plan`,
      throttle: {
        rateLimit: 100,
        burstLimit: 200,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.documentsPaymentsApi.deploymentStage });

    // ========================================================================
    // EventBridge Rules
    // ========================================================================

    // Route document processing requests
    new events.Rule(this, 'DocumentProcessingRule', {
      ruleName: `medcx-${envName}-document-processing`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.documents'],
        detailType: ['DocumentUploaded'],
      },
      targets: [new targets.SfnStateMachine(this.documentProcessingStateMachine)],
    });

    // Route payment requests
    new events.Rule(this, 'PaymentRequestRule', {
      ruleName: `medcx-${envName}-payment-request`,
      eventBus: foundationStack.eventBus,
      eventPattern: {
        source: ['medcx.payments'],
        detailType: ['PaymentRequested'],
      },
      targets: [new targets.LambdaFunction(this.paymentProcessorFunction)],
    });

    // ========================================================================
    // CloudWatch Log Groups
    // ========================================================================
    new logs.LogGroup(this, 'DocumentsPaymentsLogs', {
      logGroupName: `/medcx/${envName}/documents-payments`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'DocumentsPaymentsApiUrl', {
      value: this.documentsPaymentsApi.url,
      description: 'Documents & Payments API URL',
      exportName: `medcx-${envName}-documents-payments-api-url`,
    });

    new cdk.CfnOutput(this, 'StripeWebhookUrl', {
      value: `${this.documentsPaymentsApi.url}payments/webhook`,
      description: 'Stripe webhook URL (configure in Stripe Dashboard)',
      exportName: `medcx-${envName}-stripe-webhook-url`,
    });

    new cdk.CfnOutput(this, 'DocumentProcessorArn', {
      value: this.documentProcessorFunction.functionArn,
      description: 'Document Processor Lambda ARN',
      exportName: `medcx-${envName}-document-processor-arn`,
    });

    new cdk.CfnOutput(this, 'PaymentProcessorArn', {
      value: this.paymentProcessorFunction.functionArn,
      description: 'Payment Processor Lambda ARN',
      exportName: `medcx-${envName}-payment-processor-arn`,
    });

    new cdk.CfnOutput(this, 'DocumentProcessingStateMachineArn', {
      value: this.documentProcessingStateMachine.stateMachineArn,
      description: 'Document Processing State Machine ARN',
      exportName: `medcx-${envName}-document-processing-state-machine-arn`,
    });
  }
}
