import { NextRequest, NextResponse } from 'next/server';
import { isLocale, negotiateLocale, pathLocale } from '@/lib/locale';

export function proxy(request: NextRequest) {
  const url = request.nextUrl.clone();
  const choice = url.searchParams.get('lang');
  const explicit = isLocale(choice);
  const { locale } = negotiateLocale({
    cookie: explicit ? choice : request.cookies.get('demo-locale')?.value,
    path: url.pathname,
    acceptLanguage: request.headers.get('accept-language'),
    vercelCountry: request.headers.get('x-vercel-ip-country'),
    cloudflareCountry: request.headers.get('cf-ipcountry'),
  });
  const previous = pathLocale(url.pathname);
  const suffix = previous ? url.pathname.slice(3) : url.pathname;
  url.pathname = `/${locale}${suffix === '/' ? '' : suffix}`;
  url.searchParams.delete('lang');
  const response =
    explicit || url.pathname !== request.nextUrl.pathname
      ? NextResponse.redirect(url, 307)
      : NextResponse.next();
  if (explicit)
    response.cookies.set('demo-locale', locale, {
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      path: '/',
      maxAge: 60 * 60 * 24 * 180,
    });
  // Negotiation must not leak one visitor's preference through a shared redirect cache.
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Cookie, Accept-Language, x-vercel-ip-country, cf-ipcountry');
  return response;
}

export const config = { matcher: ['/((?!api|_next|.*\\..*).*)'] };
