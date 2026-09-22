import { expect, test } from '@playwright/test';

for (const locale of ['en', 'de', 'es']) {
  for (const width of [390, 1440]) {
    test(`static ${locale} landing at ${width}px`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.setViewportSize({ width, height: 950 });
      const response = await page.goto(`/${locale}`);
      expect(response?.status()).toBe(200);
      const policy = response?.headers()['content-security-policy'];
      expect(policy).toContain("'sha256-");
      expect(policy).not.toContain('unsafe-inline');
      expect(policy).not.toContain('unsafe-eval');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      await page.screenshot({ path: `.cache/screenshots/${locale}-${width}.png`, fullPage: true });
    });
  }
}
test('explicit locale choice persists across conflicting paths', async ({ page }) => {
  await page.goto('/en');
  await page.getByRole('link', { name: 'DE', exact: true }).click();
  await expect(page).toHaveURL('/de');
  await page.goto('/es');
  await expect(page).toHaveURL('/de');
});
test('mobile queue approves optimistically and retries an ambiguous commit with the same key', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED'))
      errors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en/review');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(3);
  await page.screenshot({ path: '.cache/screenshots/review-mobile.png', fullPage: true });
  let release: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/decisions', async (route) => {
    if (route.request().method() === 'POST') await responseGate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await expect(page.locator('.creative-card .status').first()).toHaveText('Saving…');
  await expect(page.locator('.credit-badge strong')).toHaveText('11');
  release!();
  await expect(page.getByText('Decision saved.', { exact: true })).toBeVisible();
  await expect(page.locator('.credit-badge strong')).toHaveText('11');
  await page.unroute('**/api/decisions');
  let loseFirst = true;
  const keys: string[] = [];
  await page.route('**/api/decisions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    const response = await route.fetch();
    if (loseFirst) {
      loseFirst = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Approve', exact: true }).nth(1).click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(page.locator('.credit-badge strong')).toHaveText('11');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Decision saved.', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).not.toBe('');
  await expect(page.locator('.credit-badge strong')).toHaveText('10');
  await page.getByRole('button', { name: 'Pass', exact: true }).nth(2).click();
  await expect(page.getByText('Passed', { exact: true })).toBeVisible();
  await expect(page.locator('.credit-badge strong')).toHaveText('10');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
for (const [locale, label] of [
  ['de', 'Freigeben'],
  ['es', 'Aprobar'],
] as const) {
  test(`localized mobile review in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${locale}/review`);
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `.cache/screenshots/review-${locale}.png`, fullPage: true });
  });
}
test('unknown pages recover through a styled static 404', async ({ page }) => {
  const response = await page.goto('/en/missing-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'A blank canvas.' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to the demo' }).click();
  await expect(page).toHaveURL('/en');
});

test('reset restores only the current browser session', async ({ page, browser }) => {
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await page.goto('/en/review');
    await second.goto('/en/review');
    await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
    await expect(page.locator('.credit-badge strong')).toHaveText('11');
    await expect(page.getByText('Decision saved.', { exact: true })).toBeVisible();
    await expect(second.locator('.credit-badge strong')).toHaveText('12');
    await second.getByRole('button', { name: 'Approve', exact: true }).first().click();
    await expect(second.getByText('Decision saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
    await expect(page.getByText('Demo reset. All samples are ready again.')).toBeVisible();
    await expect(page.locator('.credit-badge strong')).toHaveText('12');
    for (const button of await page.getByRole('button', { name: 'Approve', exact: true }).all())
      await expect(button).toBeEnabled();
    await second.reload();
    await expect(second.locator('.credit-badge strong')).toHaveText('11');
    await expect(
      second.getByRole('button', { name: 'Approve', exact: true }).first(),
    ).toBeDisabled();
  } finally {
    await other.close();
  }
});

test('GET deadline exposes retry and a later load recovers', async ({ page }) => {
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/decisions', async (route) => {
    if (++count === 1) {
      await gate;
      await route.abort().catch(() => {});
    } else await route.continue();
  });
  await page.goto('/en/review');
  await expect(page.getByText('The queue is unavailable. Please retry.')).toBeVisible({
    timeout: 11_000,
  });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.credit-badge strong')).toHaveText('12');
  release();
});

test('superseded GET retries cannot overwrite a newer result', async ({ page }) => {
  let count = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayedStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/decisions', async (route) => {
    const attempt = ++count;
    if (attempt === 1) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    const response = await route.fetch();
    const data = await response.json();
    if (attempt === 2) {
      started();
      await gate;
      await route.fulfill({ response, json: { ...data, balance: 3, revision: 0 } }).catch(() => {});
    } else await route.fulfill({ response, json: { ...data, balance: 9, revision: 3 } });
  });
  await page.goto('/en/review');
  const retry = page.getByRole('button', { name: 'Try again', exact: true });
  await retry.click();
  await delayedStarted;
  const canceled = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url().endsWith('/api/decisions') && request.method() === 'GET',
  });
  await retry.click();
  await canceled;
  await expect(page.locator('.credit-badge strong')).toHaveText('9');
  release();
  await expect(page.getByText('The queue is unavailable. Please retry.')).toHaveCount(0);
  await expect(page.locator('.credit-badge strong')).toHaveText('9');
});

test('GET reconciliation discards a lower revision after a decision conflict', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/decisions', async (route) => {
    if (route.request().method() === 'POST')
      return route.fulfill({ status: 409, json: { error: 'conflict' } });
    const response = await route.fetch();
    const data = await response.json();
    const initial = ++reads === 1;
    const headers = { ...response.headers() };
    delete headers['x-demo-session'];
    await route.fulfill({
      response,
      headers,
      json: { ...data, balance: initial ? 9 : 12, revision: initial ? 3 : 0 },
    });
  });
  await page.goto('/en/review');
  await expect(page.locator('.credit-badge strong')).toHaveText('9');
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await expect(page.getByText('Queue refreshed. Check the current status.')).toBeVisible();
  await expect(page.locator('.credit-badge strong')).toHaveText('9');
});

test('delivered CSP blocks an unapproved inline script', async ({ page }) => {
  await page.goto('/en/review');
  await expect(page.getByRole('button', { name: 'Reset demo', exact: true })).toBeVisible();
  await page.evaluate(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      document.documentElement.dataset.blockedUri = event.blockedURI;
      document.documentElement.dataset.blockedDirective = event.effectiveDirective;
    });
    const script = document.createElement('script');
    script.textContent = "document.documentElement.dataset.unapprovedScript = 'executed'";
    document.body.append(script);
  });
  await expect(page.locator('html')).toHaveAttribute('data-blocked-uri', 'inline');
  await expect(page.locator('html')).toHaveAttribute('data-blocked-directive', /script-src/);
  await expect(page.locator('html')).not.toHaveAttribute('data-unapproved-script');
});
