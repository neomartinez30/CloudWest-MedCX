# CloudWest MedCX - Next Generation Clinical Contact Center

## Vision
**The contact center as a 'relationship hub'**

**Cost Center > Profit Center**

The future of clinical contact centers powered by AWS that provides:
- **True Omnichannel Experience**: Seamless conversation continuity across voice, SMS, and rich messaging
- **GenAI-Powered Self-Service**: Intelligent appointment scheduling with context awareness
- **Patient 360 View**: Operational, real-time patient insights for bots, agents, and workflows
- **Proactive Care**: Automated follow-ups, reminders, and outreach campaigns
- **Frictionless Onboarding**: Easy insurance/ID capture with AI-powered document processing
- **Simple Payments**: One-click copayment processing

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           CloudWest MedCX Architecture                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐│
│  │   iPhone    │  │    SMS      │  │    Voice    │  │   Social Media          ││
│  │  Messages   │  │  (Pinpoint) │  │  (Connect)  │  │   (Outreach)            ││
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘│
│         │                │                │                      │              │
│         └────────────────┼────────────────┼──────────────────────┘              │
│                          ▼                ▼                                     │
│  ┌───────────────────────────────────────────────────────────────────────────┐ │
│  │                    Unified Channel Router (Lambda)                        │ │
│  │         • Channel Detection • Session Management • Identity Resolution    │ │
│  └───────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                         │
│         ┌────────────────────────────┼────────────────────────────┐            │
│         ▼                            ▼                            ▼            │
│  ┌─────────────┐          ┌─────────────────────┐        ┌─────────────┐       │
│  │  Amazon Lex │◄────────►│   Amazon Bedrock    │        │   Amazon    │       │
│  │    Bots     │          │   (Claude/Titan)    │        │   Connect   │       │
│  └──────┬──────┘          └─────────────────────┘        └──────┬──────┘       │
│         │                                                       │              │
│         └───────────────────────┬───────────────────────────────┘              │
│                                 ▼                                              │
│  ┌───────────────────────────────────────────────────────────────────────────┐ │
│  │                        Patient 360 Service                                │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │ │
│  │  │  Identity   │  │Conversation │  │Appointments │  │   Care      │      │ │
│  │  │  Manager    │  │   Thread    │  │  Calendar   │  │   Plans     │      │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘      │ │
│  └───────────────────────────────────────────────────────────────────────────┘ │
│                                 │                                              │
│         ┌───────────────────────┼───────────────────────────┐                  │
│         ▼                       ▼                           ▼                  │
│  ┌─────────────┐        ┌─────────────┐             ┌─────────────┐            │
│  │  DynamoDB   │        │  EventBridge│             │   S3        │            │
│  │  (Patient   │        │  (Workflows)│             │  (Documents)│            │
│  │   Data)     │        │             │             │             │            │
│  └─────────────┘        └─────────────┘             └─────────────┘            │
│                                                                                │
│  ┌───────────────────────────────────────────────────────────────────────────┐ │
│  │                      Integration Layer                                    │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │ │
│  │  │  Google     │  │   Stripe    │  │  Textract   │  │  Pinpoint   │      │ │
│  │  │  Calendar   │  │  Payments   │  │  (OCR)      │  │  Campaigns  │      │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘      │ │
│  └───────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Deployment Phases

### Phase 1: Foundation & Core Infrastructure
- VPC and networking
- DynamoDB tables (Patient, Conversations, Appointments)
- S3 buckets for documents
- Core IAM roles and policies
- Secrets Manager for API keys

### Phase 2: Patient 360 & Unified Identity
- Patient identity resolution service
- Unified patient profile management
- Cross-channel identity linking
- Patient data APIs

### Phase 3: Omnichannel Communication
- Amazon Connect instance and contact flows
- Amazon Pinpoint for SMS/MMS
- Apple Messages for Business integration
- Unified conversation threading
- Channel handoff capabilities

### Phase 4: GenAI Self-Service & Appointment Scheduler
- Amazon Lex bots with Bedrock integration
- Context-aware conversation management
- Google Calendar integration
- Interactive messaging (Time Picker, List Picker)
- Appointment confirmation workflows

### Phase 5: Document Processing & Payments
- Insurance card/ID upload via MMS
- Amazon Textract for document extraction
- Patient verification workflow
- Stripe payment integration
- Payment reminders and receipts

### Phase 6: Patient 360 Web Application
- React-based agent dashboard
- Real-time patient context
- Conversation history across channels
- Care plan management
- Embedded in Amazon Connect Agent Workspace

### Phase 7: Marketing & Proactive Outreach
- Amazon Pinpoint campaigns
- Targeted outbound calling
- Social media integration
- Patient reactivation campaigns
- Appointment reminder automation

## Key Features

### True Omnichannel Experience
```
Patient calls → Bot offers SMS for available times → Patient receives clickable time slots
→ Patient selects via tap → Confirmation sent → Conversation can continue on any channel
```

### One Patient, One Thread
- Phone number-based identity resolution
- Email as secondary identifier
- Conversation context preserved across channels
- Agents see full history regardless of channel

### Apple Messages for Business
- Message Suggest when tapping business number
- Rich interactive messages:
  - **Time Picker**: Select appointment slots
  - **List Picker**: Choose services, providers
  - **Rich Links**: View care instructions, payment links
  - **Quick Replies**: Yes/No confirmations

### GenAI Capabilities
- Natural language appointment booking
- Context-aware follow-up conversations
- Care instruction clarification
- Intelligent FAQ handling
- Sentiment analysis and escalation

## Technology Stack

| Component | AWS Service | Purpose |
|-----------|-------------|---------|
| Contact Center | Amazon Connect | Voice, chat, task routing |
| Messaging | Amazon Pinpoint | SMS, push notifications |
| Rich Messaging | Apple Messages for Business | Interactive iPhone experience |
| AI/ML | Amazon Bedrock (Claude) | GenAI conversations |
| Chatbot | Amazon Lex | Intent recognition |
| Database | Amazon DynamoDB | Patient 360 data |
| Documents | Amazon S3 + Textract | Insurance/ID processing |
| Workflows | AWS Step Functions | Complex business processes |
| Events | Amazon EventBridge | Event-driven automation |
| APIs | Amazon API Gateway | External integrations |
| Compute | AWS Lambda | Serverless business logic |
| Payments | Stripe (via Lambda) | Copayment processing |
| Calendar | Google Calendar API | Appointment scheduling |
| IaC | AWS CDK (TypeScript) | Infrastructure deployment |

## Getting Started

### Prerequisites
- AWS CLI configured with appropriate credentials
- Node.js 18+ and npm
- AWS CDK CLI (`npm install -g aws-cdk`)
- Docker (for Lambda bundling)

### Deployment

```bash
# Install dependencies
npm install

# Deploy Phase 1 (Foundation)
cdk deploy MedCX-Phase1-Foundation

# Deploy Phase 2 (Patient 360)
cdk deploy MedCX-Phase2-Patient360

# Continue with subsequent phases...
```

### Configuration

Copy `.env.example` to `.env` and configure:
```bash
# AWS Configuration
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=your-account-id

# Google Calendar
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret

# Stripe
STRIPE_SECRET_KEY=your-stripe-key

# Apple Messages for Business
APPLE_BUSINESS_ID=your-business-id
```

## Directory Structure

```
CloudWest-MedCX/
├── infrastructure/           # CDK Infrastructure
│   ├── bin/                 # CDK app entry point
│   ├── lib/                 # Stack definitions
│   │   ├── phase1-foundation/
│   │   ├── phase2-patient360/
│   │   ├── phase3-omnichannel/
│   │   ├── phase4-genai/
│   │   ├── phase5-documents-payments/
│   │   ├── phase6-dashboard/
│   │   └── phase7-marketing/
│   └── constructs/          # Reusable constructs
├── lambdas/                 # Lambda function code
│   ├── patient-service/
│   ├── conversation-manager/
│   ├── appointment-scheduler/
│   ├── document-processor/
│   ├── payment-handler/
│   └── outreach-engine/
├── lex-bots/               # Lex bot definitions
├── connect-flows/          # Connect contact flows
├── dashboard/              # Patient 360 React app
└── docs/                   # Additional documentation
```

## License

Proprietary - CloudWest Medical

## Support

Contact: support@cloudwestmedical.com
