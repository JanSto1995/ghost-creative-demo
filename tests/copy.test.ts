import { describe, expect, it } from 'vitest';
import { copy } from '@/lib/copy';
function leaves(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      Object.entries(leaves(entry, prefix ? `${prefix}.${key}` : key)),
    ),
  );
}
describe('translation coverage', () => {
  it('has exactly the same copy keys in all locales', () => {
    const english = Object.keys(leaves(copy.en)).sort();
    expect(Object.keys(leaves(copy.de)).sort()).toEqual(english);
    expect(Object.keys(leaves(copy.es)).sort()).toEqual(english);
  });
});
