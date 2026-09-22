import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generatedPages, scriptHashes, styleHashes } from './finalize-csp.mjs';
const manifest = JSON.parse(await readFile('.next/routes-manifest.json', 'utf8'));
const policy = manifest.headers
  .flatMap((rule) => rule.headers)
  .find((header) => header.key.toLowerCase() === 'content-security-policy')?.value;
assert(
  policy && !policy.includes('unsafe-inline') && !policy.includes('unsafe-eval'),
  'Production CSP must remain strict',
);
const prerender = JSON.parse(await readFile('.next/prerender-manifest.json', 'utf8'));
for (const locale of ['en', 'de', 'es']) {
  for (const suffix of ['', '/review'])
    assert(prerender.routes[`/${locale}${suffix}`], 'Expected static locale page');
}
for (const { file, html } of await generatedPages()) {
  for (const hash of scriptHashes(html))
    assert(policy.includes(hash), `Missing script hash in ${file}`);
  const styles = styleHashes(html);
  for (const hash of [...styles.elements, ...styles.attributes])
    assert(policy.includes(hash), `Missing style hash in ${file}`);
  assert(!/<[^>]+\son[a-z]+\s*=/i.test(html), `Unexpected inline event handler in ${file}`);
}
console.log(
  'Artifacts verified: six static locale pages; every inline script covered by production CSP.',
);
