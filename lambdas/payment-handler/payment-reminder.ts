export const handler = async (event: any): Promise<any> => {
  console.log('Payment Reminder:', JSON.stringify(event));
  return { statusCode: 200, body: 'OK' };
};
