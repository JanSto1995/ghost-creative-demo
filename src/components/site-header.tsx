/* Plain links deliberately request complete static documents and explicit locale changes. */
import { locales, type Locale } from '@/lib/locale';
import { copy } from '@/lib/copy';
export function SiteHeader({ locale, review = false }: { locale: Locale; review?: boolean }) {
  const t = copy[locale];
  return (
    <header className="site-header shell">
      <a className="wordmark" href={`/${locale}`} aria-label="Ghost Creative">
        ghost<span>creative</span>
        <span className="brand-dot">.</span>
      </a>
      <span className="demo-label">{t.demo}</span>
      <nav className="locale-nav" aria-label={t.language}>
        {locales.map((value) => (
          <a
            key={value}
            href={`/${value}${review ? '/review' : ''}?lang=${value}`}
            lang={value}
            hrefLang={value}
            aria-current={value === locale ? 'true' : undefined}
          >
            {value.toUpperCase()}
          </a>
        ))}
      </nav>
    </header>
  );
}
