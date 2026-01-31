import { SQSEvent } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({});
const CHANNEL_ROUTER_ARN = process.env.CHANNEL_ROUTER_ARN!;

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    await lambdaClient.send(new InvokeCommand({
      FunctionName: CHANNEL_ROUTER_ARN,
      Payload: JSON.stringify({
        action: 'routeInbound',
        channel: 'sms',
        phoneNumber: message.originationNumber,
        content: message.messageBody,
      }),
    }));
  }
};
