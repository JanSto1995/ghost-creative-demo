import 'server-only';
import { z } from 'zod';
import { briefSchema, creativeSchema, type Creative } from '@/lib/contracts';
import { demoRegistry, type ModelRegistry } from './registry';
import { mockGenerator, mockJudge, type Completion, type Provider } from './providers';

const judgmentSchema = z
  .object({ approved: z.boolean(), reason: z.string().min(1).max(400) })
  .strict();
export type PipelineResult =
  { ok: true; creative: Creative; judgment: string } | { ok: false; reason: string };
function decode(completion: Completion): unknown {
  if (completion.finish !== 'stop' || completion.text.length > 8192)
    throw new Error('Incomplete output');
  return JSON.parse(completion.text) as unknown;
}

export async function generateCreative(
  brief: unknown,
  options: {
    registry?: ModelRegistry;
    generatorModel?: string;
    judgeModel?: string;
    generator?: Provider;
    judge?: Provider;
    timeoutMs?: number;
  } = {},
): Promise<PipelineResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = briefSchema.parse(brief);
    const { generator: generatorModel, judge: judgeModel } = (
      options.registry ?? demoRegistry
    ).pair(options.generatorModel ?? 'draft', options.judgeModel ?? 'judge');
    const generator = options.generator ?? mockGenerator;
    const judge = options.judge ?? mockJudge;
    if (generator.id !== generatorModel.provider || judge.id !== judgeModel.provider)
      throw new Error('Provider identity mismatch');
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Timeout'));
      }, options.timeoutMs ?? 2000);
    });
    const work = async (): Promise<PipelineResult> => {
      const candidate = decode(
        await generator.complete(generatorModel, JSON.stringify(input), controller.signal),
      );
      // JSON serialization preserves structure; it does not isolate LLM instructions from data.
      // The schema below validates verdict shape, not its semantic independence.
      const verdict = judgmentSchema.parse(
        decode(
          await judge.complete(
            judgeModel,
            JSON.stringify({ brief: input, candidate }),
            controller.signal,
          ),
        ),
      );
      if (!verdict.approved) return { ok: false, reason: 'Judge rejected the draft.' };
      // Final deterministic gate: downstream values must match our exact allowlists.
      const creative = creativeSchema.parse(candidate);
      if (creative.format !== input.format)
        return { ok: false, reason: 'Format does not match the brief.' };
      return { ok: true, creative, judgment: verdict.reason };
    };
    return await Promise.race([work(), deadline]);
  } catch {
    return { ok: false, reason: 'Generation failed validation or could not finish.' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
