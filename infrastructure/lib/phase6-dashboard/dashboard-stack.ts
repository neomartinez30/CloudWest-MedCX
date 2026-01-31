import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Phase1FoundationStack } from '../phase1-foundation/foundation-stack';
import { Phase2Patient360Stack } from '../phase2-patient360/patient360-stack';
import * as path from 'path';

export interface Phase6DashboardStackProps extends cdk.StackProps {
  envName: string;
  foundationStack: Phase1FoundationStack;
  patient360Stack: Phase2Patient360Stack;
}

export class Phase6DashboardStack extends cdk.Stack {
  public readonly dashboardBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly dashboardApiFunction: lambda.Function;
  public readonly analyticsFunction: lambda.Function;
  public readonly dashboardApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: Phase6DashboardStackProps) {
    super(scope, id, props);

    const { envName, foundationStack, patient360Stack } = props;

    // ========================================================================
    // Cognito User Pool for Dashboard Authentication
    // ========================================================================
    this.userPool = new cognito.UserPool(this, 'DashboardUserPool', {
      userPoolName: `medcx-${envName}-dashboard-users`,
      selfSignUpEnabled: false, // Admin creates users
      signInAliases: {
        email: true,
        username: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        fullname: {
          required: true,
          mutable: true,
        },
      },
      customAttributes: {
        role: new cognito.StringAttribute({ minLen: 1, maxLen: 50, mutable: true }),
        department: new cognito.StringAttribute({ minLen: 1, maxLen: 100, mutable: true }),
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: true,
        otp: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // User Pool Client
    this.userPoolClient = this.userPool.addClient('DashboardClient', {
      userPoolClientName: `medcx-${envName}-dashboard-client`,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [
          `https://dashboard.medcx.${envName}.example.com/callback`,
          'http://localhost:3000/callback',
        ],
        logoutUrls: [
          `https://dashboard.medcx.${envName}.example.com/logout`,
          'http://localhost:3000/logout',
        ],
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // User Pool Domain
    this.userPool.addDomain('DashboardDomain', {
      cognitoDomain: {
        domainPrefix: `medcx-${envName}-dashboard`,
      },
    });

    // ========================================================================
    // S3 Bucket for Dashboard Static Assets
    // ========================================================================
    this.dashboardBucket = new s3.Bucket(this, 'DashboardBucket', {
      bucketName: `medcx-${envName}-dashboard-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================================================
    // CloudFront Distribution
    // ========================================================================
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'DashboardOAI', {
      comment: `MedCX ${envName} Dashboard OAI`,
    });

    this.dashboardBucket.grantRead(originAccessIdentity);

    this.distribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(this.dashboardBucket, {
          originAccessIdentity,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: `MedCX ${envName} Patient 360 Dashboard`,
    });

    // ========================================================================
    // Common Lambda environment variables
    // ========================================================================
    const commonEnvVars = {
      PATIENT_TABLE: foundationStack.patientTable.tableName,
      CONVERSATION_TABLE: foundationStack.conversationTable.tableName,
      APPOINTMENT_TABLE: foundationStack.appointmentTable.tableName,
      INTERACTION_TABLE: foundationStack.interactionTable.tableName,
      DOCUMENTS_BUCKET: foundationStack.documentsBucket.bucketName,
      EVENT_BUS_NAME: foundationStack.eventBus.eventBusName,
      USER_POOL_ID: this.userPool.userPoolId,
      ENVIRONMENT: envName,
    };

    // ========================================================================
    // Lambda Layer for shared utilities
    // ========================================================================
    const sharedLayer = new lambda.LayerVersion(this, 'DashboardSharedLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../lambdas/layers/shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared utilities for Dashboard Lambda functions',
    });

    // ========================================================================
    // Dashboard API Lambda
    // Backend API for the Patient 360 Dashboard
    // ========================================================================
    this.dashboardApiFunction = new nodejs.NodejsFunction(this, 'DashboardApi', {
      functionName: `medcx-${envName}-dashboard-api`,
      entry: path.join(__dirname, '../../../lambdas/dashboard/dashboard-api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadWriteData(this.dashboardApiFunction);
    foundationStack.conversationTable.grantReadWriteData(this.dashboardApiFunction);
    foundationStack.appointmentTable.grantReadWriteData(this.dashboardApiFunction);
    foundationStack.interactionTable.grantReadData(this.dashboardApiFunction);
    foundationStack.documentsBucket.grantRead(this.dashboardApiFunction);
    foundationStack.eventBus.grantPutEventsTo(this.dashboardApiFunction);

    // ========================================================================
    // Analytics Lambda
    // Generates dashboard analytics and metrics
    // ========================================================================
    this.analyticsFunction = new nodejs.NodejsFunction(this, 'Analytics', {
      functionName: `medcx-${envName}-analytics`,
      entry: path.join(__dirname, '../../../lambdas/dashboard/analytics.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 1024,
      environment: commonEnvVars,
      layers: [sharedLayer],
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions
    foundationStack.patientTable.grantReadData(this.analyticsFunction);
    foundationStack.conversationTable.grantReadData(this.analyticsFunction);
    foundationStack.appointmentTable.grantReadData(this.analyticsFunction);
    foundationStack.interactionTable.grantReadData(this.analyticsFunction);

    // ========================================================================
    // Dashboard API Gateway
    // ========================================================================
    this.dashboardApi = new apigateway.RestApi(this, 'DashboardApiGateway', {
      restApiName: `medcx-${envName}-dashboard-api`,
      description: 'Patient 360 Dashboard API for CloudWest MedCX',
      deployOptions: {
        stageName: envName,
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.OFF,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [
          `https://${this.distribution.distributionDomainName}`,
          'http://localhost:3000',
        ],
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
        allowCredentials: true,
      },
    });

    // Cognito Authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'DashboardAuthorizer', {
      cognitoUserPools: [this.userPool],
      authorizerName: `medcx-${envName}-dashboard-authorizer`,
    });

    // Patients endpoints
    const patientsResource = this.dashboardApi.root.addResource('patients');

    // List patients
    patientsResource.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardApiFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Search patients
    const searchResource = patientsResource.addResource('search');
    searchResource.addMethod('POST', new apigateway.LambdaIntegration(this.dashboardApiFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Patient by ID
    const patientByIdResource = patientsResource.addResource('{patientId}');
    patientByIdResource.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardApiFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    patientByIdResource.addMethod('PUT', new apigateway.LambdaIntegration(this.dashboardApiFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Patient 360 view
    const patient360Resource = patientByIdResource.addResource('360');
    patient360Resource.addMethod('GET', new apigateway.LambdaIntegration(patient360Stack.patientServiceFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Patient conversations
    const patientConversationsResource = patientByIdResource.addResource('conversations');
    patientConversationsResource.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardApiFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Patient appointments
    const patientAppointmentsResource = patientByIdResource.addResource('appointments');
    patientAppointmentsResource.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardApiFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Conversations endpoints
    const conversationsResource = this.dashboardApi.root.addResource('conversations');

    // List active conversations
    conversationsResource.addMethod('GET', new apigateway.LambdaIntegration(this.dashboardApiFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Conversation by ID
    const conversationByIdResource = conversationsResource.addResource('{threadId}');
    conversationByIdResource.addMethod('GET', new apigateway.LambdaIntegration(patient360Stack.conversationManagerFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Send message in conversation
    const messagesResource = conversationByIdResource.addResource('messages');
    messagesResource.addMethod('POST', new apigateway.LambdaIntegration(patient360Stack.conversationManagerFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Analytics endpoints
    const analyticsResource = this.dashboardApi.root.addResource('analytics');

    // Dashboard overview
    const overviewResource = analyticsResource.addResource('overview');
    overviewResource.addMethod('GET', new apigateway.LambdaIntegration(this.analyticsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Patient engagement metrics
    const engagementResource = analyticsResource.addResource('engagement');
    engagementResource.addMethod('GET', new apigateway.LambdaIntegration(this.analyticsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Appointment analytics
    const appointmentAnalyticsResource = analyticsResource.addResource('appointments');
    appointmentAnalyticsResource.addMethod('GET', new apigateway.LambdaIntegration(this.analyticsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Channel analytics
    const channelAnalyticsResource = analyticsResource.addResource('channels');
    channelAnalyticsResource.addMethod('GET', new apigateway.LambdaIntegration(this.analyticsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ========================================================================
    // CloudWatch Log Groups
    // ========================================================================
    new logs.LogGroup(this, 'DashboardLogs', {
      logGroupName: `/medcx/${envName}/dashboard`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Patient 360 Dashboard URL',
      exportName: `medcx-${envName}-dashboard-url`,
    });

    new cdk.CfnOutput(this, 'DashboardApiUrl', {
      value: this.dashboardApi.url,
      description: 'Dashboard API URL',
      exportName: `medcx-${envName}-dashboard-api-url`,
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: `medcx-${envName}-user-pool-id`,
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: `medcx-${envName}-user-pool-client-id`,
    });

    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `medcx-${envName}-dashboard.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito Domain',
      exportName: `medcx-${envName}-cognito-domain`,
    });

    new cdk.CfnOutput(this, 'DashboardBucketName', {
      value: this.dashboardBucket.bucketName,
      description: 'Dashboard S3 Bucket Name',
      exportName: `medcx-${envName}-dashboard-bucket`,
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront Distribution ID',
      exportName: `medcx-${envName}-cloudfront-distribution-id`,
    });
  }
}
