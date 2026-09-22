export const locales = ['en', 'de', 'es'] as const;
export type Locale = (typeof locales)[number];
export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && locales.some((locale) => locale === value);

export function pathLocale(path: string): Locale | undefined {
  const first = path.split('/')[1];
  return isLocale(first) ? first : undefined;
}

export function languagePreference(header: string): Locale | undefined {
  return header
    .slice(0, 2048)
    .split(',')
    .map((entry, order) => {
      const [tag = '', ...params] = entry.trim().toLowerCase().split(';');
      const quality = params
        .find((part) => part.trim().startsWith('q='))
        ?.trim()
        .slice(2);
      // Malformed weights are ignored rather than accidentally becoming priority 1.
      const q =
        quality === undefined
          ? 1
          : /^(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality)
            ? Number(quality)
            : 0;
      return { locale: tag.split('-')[0], q, order };
    })
    .filter(
      (entry): entry is { locale: Locale; q: number; order: number } =>
        isLocale(entry.locale) && entry.q > 0,
    )
    .sort((a, b) => b.q - a.q || a.order - b.order)[0]?.locale;
}

const countryLanguage: Readonly<Record<string, Locale>> = {
  DE: 'de',
  AT: 'de',
  CH: 'de',
  MX: 'es',
  ES: 'es',
  AR: 'es',
  CO: 'es',
  CL: 'es',
  PE: 'es',
  US: 'en',
  GB: 'en',
  CA: 'en',
  AU: 'en',
  NZ: 'en',
  IE: 'en',
};

export function negotiateLocale(input: {
  cookie?: string | undefined;
  path: string;
  acceptLanguage?: string | null;
  vercelCountry?: string | null;
  cloudflareCountry?: string | null;
}): { locale: Locale; source: 'cookie' | 'path' | 'language' | 'country' | 'default' } {
  if (isLocale(input.cookie)) return { locale: input.cookie, source: 'cookie' };
  const path = pathLocale(input.path);
  if (path) return { locale: path, source: 'path' };
  const language = languagePreference(input.acceptLanguage ?? '');
  if (language) return { locale: language, source: 'language' };
  for (const country of [input.vercelCountry, input.cloudflareCountry]) {
    const locale = countryLanguage[country?.toUpperCase() ?? ''];
    if (locale) return { locale, source: 'country' };
  }
  return { locale: 'en', source: 'default' };
}
