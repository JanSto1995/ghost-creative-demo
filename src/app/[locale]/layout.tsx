import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/lib/locale';
import { copy } from '@/lib/copy';
import '@/styles/globals.css';

const sans = localFont({
  src: '../../../node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2',
  display: 'swap',
  variable: '--font-sans',
});
export const metadata: Metadata = {
  title: { default: 'Ghost Creative · Engineering demo', template: '%s · Ghost Creative demo' },
  description: 'An independently implemented creative workflow demo with synthetic data.',
  robots: { index: false, follow: false },
};
export const dynamicParams = false;
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}
export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <html lang={locale} className={sans.variable}>
      <body>
        <a href="#main" className="skip-link">
          {copy[locale].skip}
        </a>
        {children}
      </body>
    </html>
  );
}
