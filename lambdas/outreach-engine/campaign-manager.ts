export const handler = async (event: any): Promise<any> => {
  console.log('Campaign Manager:', JSON.stringify(event));
  return { statusCode: 200, body: JSON.stringify({ campaigns: [] }) };
};
