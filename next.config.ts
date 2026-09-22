import type { NextConfig } from 'next';
const development = process.env.NODE_ENV === 'development';
// Build finalization adds hashes for the exact prerendered inline bootstrap scripts.
// Production never allows arbitrary inline script, eval, remote script or CSS.
// The framework fallback also gets exact hashes for its built-in inline styles.
const csp = [
  "default-src 'none'",
  `script-src 'self'${development ? " 'unsafe-inline' 'unsafe-eval'" : ''}`,
  `style-src 'self'${development ? " 'unsafe-inline'" : ''}`,
  "font-src 'self'",
  "img-src 'self' data:",
  `connect-src 'self'${development ? ' ws: wss:' : ''}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');
const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  experimental: { globalNotFound: true },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        ],
      },
    ];
  },
};
export default config;
