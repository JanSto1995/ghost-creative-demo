import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? htmlFiles(path.join(directory, entry.name))
        : entry.name.endsWith('.html')
          ? [path.join(directory, entry.name)]
          : [],
    ),
  );
  return nested.flat();
}
export function scriptHashes(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]))
    .map((match) => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
}
export function styleHashes(html) {
  const digest = (value) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
  const entities = {
    '&quot;': '"',
    '&amp;': '&',
    '&#x27;': "'",
    '&#39;': "'",
    '&lt;': '<',
    '&gt;': '>',
  };
  return {
    elements: [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) =>
      digest(match[1]),
    ),
    attributes: [...html.matchAll(/<[a-z][^>]*?\sstyle="([^"]*)"/gi)].map((match) =>
      digest(match[1].replace(/&(?:quot|amp|lt|gt|#x27|#39);/g, (entity) => entities[entity])),
    ),
  };
}
export async function generatedPages() {
  return Promise.all(
    (await htmlFiles('.next/server/app')).map(async (file) => ({
      file,
      html: await readFile(file, 'utf8'),
    })),
  );
}
if (process.argv[1]?.endsWith('finalize-csp.mjs')) {
  const pages = await generatedPages();
  if (pages.length < 6) throw new Error('Expected all localized static pages');
  const hashes = [...new Set(pages.flatMap(({ html }) => scriptHashes(html)))].sort();
  if (!hashes.length) throw new Error('No bootstrap scripts found; inspect framework output');
  const location = '.next/routes-manifest.json';
  const manifest = JSON.parse(await readFile(location, 'utf8'));
  const policies = manifest.headers
    .flatMap((rule) => rule.headers)
    .filter((header) => header.key.toLowerCase() === 'content-security-policy');
  if (policies.length !== 1 || !policies[0].value.includes("script-src 'self'"))
    throw new Error('Unexpected Next headers manifest');
  policies[0].value = policies[0].value.replace(
    /script-src [^;]+/,
    `script-src 'self' ${hashes.join(' ')}`,
  );
  const styles = pages.map(({ html }) => styleHashes(html));
  const elements = [...new Set(styles.flatMap((value) => value.elements))];
  const attributes = [...new Set(styles.flatMap((value) => value.attributes))];
  if (elements.length)
    policies[0].value = policies[0].value.replace(
      "style-src 'self'",
      `style-src 'self' ${elements.join(' ')}`,
    );
  if (attributes.length)
    policies[0].value += `; style-src-attr 'unsafe-hashes' ${attributes.join(' ')}`;
  if (policies[0].value.length > 12000) throw new Error('CSP exceeds demo header budget');
  await writeFile(location, JSON.stringify(manifest));
  console.log(
    `CSP finalized: ${pages.length} static documents, ${hashes.length} script hashes, ${policies[0].value.length} header bytes.`,
  );
}
