import 'server-only';
import { randomBytes } from 'node:crypto';
import { fixtures } from '@/lib/contracts';
import { MemoryStore } from './store';
import { DemoSessions } from './sessions';
import { createDecisionHandlers } from './http';
import { createWebhookHandler, WebhookVerifier } from './webhook';
import { generateCreative } from './pipeline';

async function createRuntime() {
  const items = await Promise.all(
    fixtures.map(async (fixture) => {
      const result = await generateCreative({ subject: fixture.hook, format: fixture.format });
      if (!result.ok) throw new Error('Synthetic sample failed validation');
      return { ...result.creative, id: fixture.id, status: fixture.status };
    }),
  );
  return {
    decisions: createDecisionHandlers(new DemoSessions(() => new MemoryStore(12, items))),
    // Ephemeral key: never exposed or printed. No real sender is configured.
    webhook: createWebhookHandler(new WebhookVerifier(randomBytes(32))),
  };
}
const processState = globalThis as typeof globalThis & {
  demoRuntime?: ReturnType<typeof createRuntime>;
};
export const runtime = (processState.demoRuntime ??= createRuntime());
