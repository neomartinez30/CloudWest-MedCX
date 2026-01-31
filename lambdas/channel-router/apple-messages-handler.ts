export const handler = async (event: any): Promise<any> => {
  console.log('Apple Messages Handler:', JSON.stringify(event));
  return { statusCode: 200, body: 'OK' };
};
