export const handler = async (event: any): Promise<any> => {
  console.log('Channel Handoff:', JSON.stringify(event));
  return { statusCode: 200, body: 'OK' };
};
