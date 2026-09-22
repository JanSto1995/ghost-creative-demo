import 'server-only';
import { briefSchema, fixtures } from '@/lib/contracts';
import type { Model } from './registry';

export type Completion = { text: string; finish: 'stop' | 'length' | 'blocked' };
export interface Provider {
  readonly id: string;
  complete(model: Model, input: string, signal: AbortSignal): Promise<Completion>;
}
export const mockGenerator: Provider = {
  id: 'mock-studio',
  async complete(_model, input, signal) {
    signal.throwIfAborted();
    const brief = briefSchema.parse(JSON.parse(input) as unknown);
    const sample = fixtures.find((item) => item.hook === brief.subject) ?? fixtures[0]!;
    return {
      finish: 'stop',
      text: JSON.stringify({
        hook: sample.hook,
        caption: sample.caption,
        format: brief.format,
        palette: sample.palette,
      }),
    };
  },
};
export const mockJudge: Provider = {
  id: 'mock-review',
  async complete(_model, _input, signal) {
    signal.throwIfAborted();
    return {
      finish: 'stop',
      text: JSON.stringify({
        approved: true,
        reason: 'Simulated approval; the mock does not evaluate the draft.',
      }),
    };
  },
};
