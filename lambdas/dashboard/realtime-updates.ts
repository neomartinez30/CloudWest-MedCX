export const handler = async (event: any): Promise<any> => {
  console.log('Realtime Updates:', JSON.stringify(event));
  return { statusCode: 200, body: 'OK' };
};
