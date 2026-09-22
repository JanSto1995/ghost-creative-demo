import { runtime as demo } from '@/server/runtime';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return (await demo).decisions.GET(request);
}
export async function POST(request: Request) {
  return (await demo).decisions.POST(request);
}
