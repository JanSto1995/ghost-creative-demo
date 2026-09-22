import { notFound } from 'next/navigation';
import { SiteHeader } from '@/components/site-header';
import { ReviewQueue } from '@/components/review-queue';
import { copy } from '@/lib/copy';
import { isLocale } from '@/lib/locale';
export const metadata = { title: 'Review queue' };
export default async function ReviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = copy[locale];
  return (
    <>
      <SiteHeader locale={locale} review />
      <main id="main" className="review-main shell">
        <a className="text-link" href={`/${locale}`}>
          ← {t.back}
        </a>
        <p className="eyebrow review-eyebrow">{t.reviewEyebrow}</p>
        <h1>{t.reviewTitle}</h1>
        <p className="intro">{t.reviewIntro}</p>
        <ReviewQueue text={t} />
        <p className="quiet-note shared-note">{t.shared}</p>
      </main>
    </>
  );
}
