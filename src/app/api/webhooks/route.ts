import { runtime as demo } from '@/server/runtime';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return (await demo).webhook(request);
}
