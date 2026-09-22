import 'server-only';

export type Model = Readonly<{ id: string; provider: string; aliases: readonly string[] }>;
export class ModelRegistry {
  private readonly lookup = new Map<string, Model>();
  constructor(models: readonly Model[]) {
    for (const input of models) {
      const model = Object.freeze({
        ...input,
        id: normalize(input.id),
        provider: normalize(input.provider),
        aliases: [...input.aliases],
      });
      if (!model.id || !model.provider) throw new Error('Invalid model identity');
      for (const name of [model.id, ...model.aliases]) {
        const alias = normalize(name);
        if (!alias || this.lookup.has(alias)) throw new Error('Model alias collision');
        this.lookup.set(alias, model);
      }
    }
  }
  resolve(name: string): Model {
    const model = this.lookup.get(normalize(name));
    if (!model) throw new Error('Unknown model');
    return model;
  }
  pair(generatorName: string, judgeName: string) {
    const generator = this.resolve(generatorName);
    const judge = this.resolve(judgeName);
    if (generator.provider === judge.provider)
      throw new Error('Judge must use a different provider');
    return { generator, judge };
  }
}
const normalize = (value: string) => value.trim().toLowerCase();
export const demoRegistry = new ModelRegistry([
  { id: 'studio/draft-v1', provider: 'mock-studio', aliases: ['draft'] },
  { id: 'review/check-v1', provider: 'mock-review', aliases: ['judge'] },
]);
