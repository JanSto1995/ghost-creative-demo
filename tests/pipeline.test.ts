import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateCreative } from '@/server/pipeline';
import { ModelRegistry } from '@/server/registry';
import { mockGenerator, mockJudge, type Completion, type Provider } from '@/server/providers';
const brief = { subject: 'A fictional studio', format: 'portrait' };
const candidate = {
  hook: 'A fresh start',
  caption: 'Make room.',
  format: 'portrait',
  palette: 'violet',
};
const generator = (text: string, finish: Completion['finish'] = 'stop'): Provider => ({
  id: 'mock-studio',
  complete: vi.fn().mockResolvedValue({ text, finish }),
});
afterEach(() => vi.useRealTimers());
describe('independent, fail-closed generation', () => {
  it('returns a validated creative from the two mock providers', async () => {
    expect(await generateCreative(brief)).toMatchObject({
      ok: true,
      creative: { format: 'portrait' },
    });
  });
  it('rejects alias collisions after case and whitespace normalization', () => {
    expect(
      () =>
        new ModelRegistry([
          { id: 'a', provider: 'one', aliases: ['fast'] },
          { id: 'b', provider: 'two', aliases: [' FAST '] },
        ]),
    ).toThrow('alias collision');
  });
  it('rejects different models under the same provider, including aliases', async () => {
    const registry = new ModelRegistry([
      { id: 'a', provider: 'ONE', aliases: ['draft'] },
      { id: 'b', provider: ' one ', aliases: ['judge'] },
    ]);
    expect(await generateCreative(brief, { registry })).toMatchObject({ ok: false });
  });
  it('rejects a provider implementation with the wrong identity', async () => {
    expect(await generateCreative(brief, { generator: mockJudge })).toMatchObject({ ok: false });
  });
  it('rejects unknown model identifiers', async () => {
    expect(await generateCreative(brief, { judgeModel: 'missing' })).toMatchObject({ ok: false });
  });
  it.each(['length', 'blocked'] as const)(
    'rejects a complete-looking response marked %s',
    async (finish) => {
      const judge = { ...mockJudge, complete: vi.fn(mockJudge.complete) };
      expect(
        await generateCreative(brief, {
          generator: generator(JSON.stringify(candidate), finish),
          judge,
        }),
      ).toMatchObject({ ok: false });
      expect(judge.complete).not.toHaveBeenCalled();
    },
  );
  it.each(['{"hook":', '```json\n{}\n```', 'x'.repeat(8193)])(
    'rejects malformed or oversized output',
    async (text) => {
      expect(await generateCreative(brief, { generator: generator(text) })).toMatchObject({
        ok: false,
      });
    },
  );
  it.each([
    { ...candidate, format: 'unsupported' },
    { ...candidate, palette: 'external-url' },
    { ...candidate, command: 'extra field' },
    { ...candidate, caption: '' },
  ])('applies deterministic allowlists despite an approving judge', async (data) => {
    expect(
      await generateCreative(brief, { generator: generator(JSON.stringify(data)) }),
    ).toMatchObject({ ok: false });
  });
  it('checks output format against the brief', async () => {
    expect(
      await generateCreative(
        { ...brief, format: 'square' },
        { generator: generator(JSON.stringify(candidate)) },
      ),
    ).toMatchObject({ ok: false });
  });
  it.each([
    { text: '{"approved":false,"reason":"Off brief"}', finish: 'stop' },
    { text: '{"approved":true,"reason":"OK"}', finish: 'length' },
    { text: '{"approved":"yes","reason":"OK"}', finish: 'stop' },
  ] satisfies Completion[])('rejects failed or invalid judgments', async (completion) => {
    const judge: Provider = { id: mockJudge.id, complete: vi.fn().mockResolvedValue(completion) };
    expect(await generateCreative(brief, { judge })).toMatchObject({ ok: false });
  });
  it('validates the brief before calling providers', async () => {
    const complete = vi.fn(mockGenerator.complete);
    expect(
      await generateCreative(
        { ...brief, extra: true },
        { generator: { id: mockGenerator.id, complete } },
      ),
    ).toMatchObject({ ok: false });
    expect(complete).not.toHaveBeenCalled();
  });
  it('bounds a provider that ignores abort signals', async () => {
    vi.useFakeTimers();
    const result = generateCreative(brief, {
      generator: { id: mockGenerator.id, complete: () => new Promise(() => {}) },
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ ok: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
