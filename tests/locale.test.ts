import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { languagePreference, negotiateLocale } from '@/lib/locale';
import { proxy } from '@/proxy';

describe('locale precedence', () => {
  it('honors a saved preference before an explicit path', () => {
    expect(
      negotiateLocale({
        cookie: 'de',
        path: '/es/review',
        acceptLanguage: 'en',
        vercelCountry: 'MX',
      }),
    ).toEqual({ locale: 'de', source: 'cookie' });
  });
  it('uses the path before language and country', () => {
    expect(
      negotiateLocale({
        cookie: 'invalid',
        path: '/es',
        acceptLanguage: 'de',
        vercelCountry: 'US',
      }),
    ).toEqual({ locale: 'es', source: 'path' });
  });
  it('uses weighted language preferences before country', () => {
    expect(
      negotiateLocale({
        path: '/',
        acceptLanguage: 'fr;q=1,de-DE;q=0.7,es-MX;q=0.9,en;q=0',
        vercelCountry: 'DE',
      }),
    ).toEqual({ locale: 'es', source: 'language' });
  });
  it.each([
    { vercelCountry: 'DE' },
    { cloudflareCountry: 'AT' },
    { vercelCountry: 'XX', cloudflareCountry: 'CH' },
  ])('uses recognized host countries: %o', (country) => {
    expect(negotiateLocale({ path: '/', ...country })).toEqual({ locale: 'de', source: 'country' });
  });
  it('falls back to English with unknown countries and languages', () => {
    expect(
      negotiateLocale({ path: '/design', acceptLanguage: '*;q=0.5,fr', vercelCountry: 'XX' }),
    ).toEqual({ locale: 'en', source: 'default' });
  });
  it.each([
    ['de;q=0,es;q=0.2', 'es'],
    ['de;q=garbage,en;q=0.3', 'en'],
    ['es;q=1.1,de;q=0.7', 'de'],
    ['ES-mx; q=0.8,en;q=0.8', 'es'],
    ['es;q=-1,de;q=0.6', 'de'],
    ['fr,*', undefined],
  ])('parses %s', (header, expected) => expect(languagePreference(header)).toBe(expected));
  it('redirects without loops and preserves unrelated query parameters', () => {
    const response = proxy(
      new NextRequest('http://localhost/en/review?tab=all', {
        headers: { cookie: 'demo-locale=es' },
      }),
    );
    expect(response.headers.get('location')).toBe('http://localhost/es/review?tab=all');
    const next = proxy(
      new NextRequest('http://localhost/es/review', { headers: { cookie: 'demo-locale=es' } }),
    );
    expect(next.headers.get('location')).toBeNull();
    expect(next.headers.get('cache-control')).toBe('private, no-store');
  });
  it('makes a language switch override and replace the old preference', () => {
    const response = proxy(
      new NextRequest('https://example.com/en?lang=de', { headers: { cookie: 'demo-locale=es' } }),
    );
    expect(response.headers.get('location')).toBe('https://example.com/de');
    expect(response.cookies.get('demo-locale')?.value).toBe('de');
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });
});
