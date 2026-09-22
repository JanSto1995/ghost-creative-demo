/* Plain navigation recovers even when client routing cannot initialize. */
/* eslint-disable @next/next/no-html-link-for-pages */
import '@/styles/globals.css';
export default function GlobalNotFound() {
  return (
    <html lang="en">
      <body>
        <main className="fallback-page">
          <p className="eyebrow">Ghost Creative demo / 404</p>
          <h1>A blank canvas.</h1>
          <p>This page does not exist.</p>
          <a className="button primary" href="/en">
            Back to the demo
          </a>
        </main>
      </body>
    </html>
  );
}
