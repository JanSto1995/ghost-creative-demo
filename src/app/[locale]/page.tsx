import { notFound } from 'next/navigation';
import { SiteHeader } from '@/components/site-header';
import { copy } from '@/lib/copy';
import { isLocale } from '@/lib/locale';

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = copy[locale];
  return (
    <>
      <SiteHeader locale={locale} />
      <main id="main">
        <section className="hero shell">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="tiny-orbit" aria-hidden="true" />
              {t.eyebrow}
            </p>
            <h1>
              {t.headline}
              <br />
              <span>{t.accent}</span>
            </h1>
            <p className="intro">{t.intro}</p>
            <div className="hero-actions">
              <a className="button primary" href={`/${locale}/review`}>
                {t.open}
                <span aria-hidden="true">↗</span>
              </a>
              <a className="text-link" href="#workflow">
                {t.secondary}
                <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="quiet-note">{t.note}</p>
          </div>
          <div
            className="showcase"
            role="img"
            aria-label={`${t.canvasLabel}: ${t.sampleHook.replace('\n', ' ')}`}
          >
            <div className="poster-back" />
            <div className="poster">
              <div className="poster-top">
                <span>{t.sample}</span>
                <span aria-hidden="true">✳</span>
              </div>
              <div className="sculpture">
                <div className="arch arch-one" />
                <div className="arch arch-two" />
                <div className="orb" />
              </div>
              <p className="poster-hook">{t.sampleHook}</p>
              <div className="poster-bottom">
                <span>{t.sampleFooter}</span>
                <span>01—03</span>
              </div>
            </div>
            <div className="floating-label">
              <span className="check-symbol" aria-hidden="true">
                ✓
              </span>
              {t.canvasLabel}
            </div>
          </div>
        </section>
        <div className="ribbon">
          <div className="shell ribbon-inner">
            <strong>{t.ribbon}</strong>
            <span>{t.ribbonText}</span>
            <span className="ribbon-flower" aria-hidden="true">
              ✳
            </span>
          </div>
        </div>
        <section id="workflow" className="workflow shell">
          <p className="eyebrow">{t.section}</p>
          <div className="section-heading">
            <h2>{t.sectionTitle}</h2>
            <p>{t.sectionIntro}</p>
          </div>
          <div className="steps">
            {t.steps.map((step, index) => (
              <article className="step" key={step.title}>
                <div className="step-top">
                  <span>0{index + 1}</span>
                  <span className={`step-glyph glyph-${index}`} aria-hidden="true">
                    {['✳', '◎', '↗'][index]}
                  </span>
                </div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="closing shell">
          <div>
            <h2>{t.bottomTitle}</h2>
            <p>{t.bottomText}</p>
          </div>
          <a className="button primary" href={`/${locale}/review`}>
            {t.open}
            <span aria-hidden="true">↗</span>
          </a>
        </section>
      </main>
      <footer className="site-footer shell">
        <p>{t.footer}</p>
        <a href="https://ghostcreative.ai" target="_blank" rel="noreferrer">
          {t.original} ↗
        </a>
      </footer>
    </>
  );
}
