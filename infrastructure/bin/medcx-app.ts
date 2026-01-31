#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Phase1FoundationStack } from '../lib/phase1-foundation/foundation-stack';
import { Phase2Patient360Stack } from '../lib/phase2-patient360/patient360-stack';
import { Phase3OmnichannelStack } from '../lib/phase3-omnichannel/omnichannel-stack';
import { Phase4GenAIStack } from '../lib/phase4-genai/genai-stack';
import { Phase5DocumentsPaymentsStack } from '../lib/phase5-documents-payments/documents-payments-stack';
import { Phase6DashboardStack } from '../lib/phase6-dashboard/dashboard-stack';
import { Phase7MarketingStack } from '../lib/phase7-marketing/marketing-stack';

const app = new cdk.App();

// Environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const envName = app.node.tryGetContext('medcx:environment') || 'dev';

// Common tags for all resources
const commonTags = {
  Project: 'CloudWest-MedCX',
  Environment: envName,
  ManagedBy: 'CDK',
};

// ============================================================================
// PHASE 1: Foundation & Core Infrastructure
// ============================================================================
const phase1 = new Phase1FoundationStack(app, 'MedCX-Phase1-Foundation', {
  env,
  description: 'CloudWest MedCX - Phase 1: Foundation infrastructure (VPC, DynamoDB, S3, IAM)',
  envName,
});

// Apply common tags to Phase 1
Object.entries(commonTags).forEach(([key, value]) => {
  cdk.Tags.of(phase1).add(key, value);
});

// ============================================================================
// PHASE 2: Patient 360 & Unified Identity
// ============================================================================
const phase2 = new Phase2Patient360Stack(app, 'MedCX-Phase2-Patient360', {
  env,
  description: 'CloudWest MedCX - Phase 2: Patient 360 and identity management',
  envName,
  foundationStack: phase1,
});

Object.entries(commonTags).forEach(([key, value]) => {
  cdk.Tags.of(phase2).add(key, value);
});

// ============================================================================
// PHASE 3: Omnichannel Communication
// ============================================================================
const phase3 = new Phase3OmnichannelStack(app, 'MedCX-Phase3-Omnichannel', {
  env,
  description: 'CloudWest MedCX - Phase 3: Omnichannel communication (Connect, Pinpoint, Apple Messages)',
  envName,
  foundationStack: phase1,
  patient360Stack: phase2,
});

Object.entries(commonTags).forEach(([key, value]) => {
  cdk.Tags.of(phase3).add(key, value);
});

// ============================================================================
// PHASE 4: GenAI Self-Service
// ============================================================================
const phase4 = new Phase4GenAIStack(app, 'MedCX-Phase4-GenAI', {
  env,
  description: 'CloudWest MedCX - Phase 4: GenAI self-service and appointment scheduling',
  envName,
  foundationStack: phase1,
  patient360Stack: phase2,
  omnichannelStack: phase3,
});

Object.entries(commonTags).forEach(([key, value]) => {
  cdk.Tags.of(phase4).add(key, value);
});

// ============================================================================
// PHASE 5: Documents & Payments
// ============================================================================
const phase5 = new Phase5DocumentsPaymentsStack(app, 'MedCX-Phase5-DocumentsPayments', {
  env,
  description: 'CloudWest MedCX - Phase 5: Document processing and payment handling',
  envName,
  foundationStack: phase1,
  patient360Stack: phase2,
});

Object.entries(commonTags).forEach(([key, value]) => {
  cdk.Tags.of(phase5).add(key, value);
});

// ============================================================================
// PHASE 6: Patient 360 Dashboard
// ============================================================================
const phase6 = new Phase6DashboardStack(app, 'MedCX-Phase6-Dashboard', {
  env,
  description: 'CloudWest MedCX - Phase 6: Patient 360 web dashboard',
  envName,
  foundationStack: phase1,
  patient360Stack: phase2,
});

Object.entries(commonTags).forEach(([key, value]) => {
  cdk.Tags.of(phase6).add(key, value);
});

// ============================================================================
// PHASE 7: Marketing & Outreach
// ============================================================================
const phase7 = new Phase7MarketingStack(app, 'MedCX-Phase7-Marketing', {
  env,
  description: 'CloudWest MedCX - Phase 7: Marketing and proactive outreach',
  envName,
  foundationStack: phase1,
  patient360Stack: phase2,
  omnichannelStack: phase3,
});

Object.entries(commonTags).forEach(([key, value]) => {
  cdk.Tags.of(phase7).add(key, value);
});

app.synth();
