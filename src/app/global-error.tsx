'use client';
import '@/styles/globals.css';
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="fallback-page">
          <p className="eyebrow">Ghost Creative demo</p>
          <h1>Something went wrong.</h1>
          <p>Please try loading this page again.</p>
          <button className="button primary" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
