export const handler = async (event: any): Promise<any> => {
  console.log('Connect Integration:', JSON.stringify(event));
  return { statusCode: 200, body: 'OK' };
};
