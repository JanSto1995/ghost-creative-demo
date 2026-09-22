# Build notes

Verified locally on **2026-09-22**, with Node.js 24.11.1 and npm 11.6.2 on macOS ARM64. Dependency versions are pinned in `package-lock.json`. No application environment variables or external services are required.

## Reproduce

```sh
npm ci
npm run typecheck
npm run lint
npm test
NEXT_TELEMETRY_DISABLED=1 npm run build
npx playwright install chromium
npm run test:browser
```

Playwright starts `next start` on `127.0.0.1:3100`, waits for readiness and stops it afterward. CI installs Chromium with `--with-deps` and requires the browser suite after the build. npm cache and browser storage can be redirected with local environment variables; the repository does not set an npm cache path.

## Results on 2026-09-22

| Check                           | Result                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`             | Passed with strict types                                                                                            |
| `npm run lint`                  | Passed, zero warnings                                                                                               |
| `npm test`                      | 93 tests passed across 8 files                                                                                      |
| `npm run build`                 | Passed; 6 localized pages, 3 dynamic API routes                                                                     |
| CSP artifact check              | 8 static documents, 9 script hashes, 1,144-byte policy                                                              |
| `npm run test:browser`          | 16 Chromium tests passed against the built app                                                                      |
| SQL regression negative control | Restoring the former conflict branch made the delayed-claim test fail: token 2 followed token 3; fixed SQL restored |
| Screenshot                      | `docs/screenshot.png` copied from the current EN desktop capture; below 400 KB                                      |

The API suite covers separate session state, oldest-session eviction, scoped reset, monotonic revisions, separate read/write budgets, global and concurrent-request caps, stalled/chunked bodies, cancellation, and a decision arriving after reset. SQL tests create a fresh PGlite database for each test, including their own leases and bookings. The delayed-candidate test interleaves a successful claim for another resource and checks both the subsequent fence and its fresh expiry.

Browser checks cover EN/DE/ES landing pages at 390px and 1440px, localized mobile review, cookie preference, session isolation and reset, optimistic decisions, lost-response retry, GET timeout/recovery, canceled overlapping GETs, lower-revision rejection, 404 recovery, delivered CSP and rejected inline JavaScript. The updated DE/ES mobile captures and the EN README capture were visually inspected for wrapping and overlap.

All 53 translation leaves have matching keys in EN/DE/ES. Changed German strings stay within 130% of English length. The judge is explicitly simulated in all three languages; it does not assess quality. The two rewritten section headlines preserve the same meaning across locales. Fictional sample creatives remain English.

## Limits

- PGlite executes PostgreSQL in memory with one connection. The trigger regression models delayed candidate evaluation; actual row-lock contention across connections was not tested because no local PostgreSQL server was available.
- Sessions, rate limits and state are process-local. The oldest of 100 sessions is evicted when another is created; restarts clear all sessions. Tabs sharing a browser cookie share one session. New sessions can bypass individual budgets, and the global cap can still be exhausted.
- Cookie isolation and Origin checks are not authentication. There is no durable storage, distributed coordination, real model evaluation, webhook sender, delivery service or scheduler daemon.
- CSP finalization depends on the pinned Next.js manifest format. The global 404 option remains experimental; browser CI guards the actual delivered policy and hydration.
- GitHub Actions was configured but not run remotely. Checks do not establish load capacity, non-Chromium compatibility or formal accessibility conformance.
