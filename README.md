# solid-octo-guacamole

## Tests

From the repository root, after `npm ci`:

| Command | Runs |
|---|---|
| `npm test` | Every workspace's Vitest suites (Node, and workerd through `@cloudflare/vitest-plugin`), then `scripts/*.test.mjs`. Needs no browser. |
| `npm run test:browser` | The browser suites in `apps/web/browser/`: headless Chromium against the web, ingest and content Workers. Not part of `npm test`. Under a minute. |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` | The other standing checks. |

### The browser suites

`npm run test:browser` bundles the web, ingest and content Workers as `wrangler deploy` would, runs them in one Miniflare on a fresh PGlite database and one shared R2 bucket, and drives headless Chromium against them. Chromium visits `https://rarepair.fans` and `https://content.rarepair.fans`, which it resolves to the local Workers, so web's same-origin checks, its `__Secure-` session cookie (accounts sign in through the real form and link) and its CSP apply as in production. Web's `ingest` queue is delivered to the real ingest Worker, with no wait to fill a batch and a retry after a second rather than two minutes; the retry count is as deployed. That delay is under the job's 60-second lease, so a job that dies holding its lease isn't retried here as it is deployed: `site.waitForUpload` times out on `processing`. Today the suites check spec 21's WCAG 2.2 AA and keyboard cases (`apps/web/browser/a11y/`) and one upload from page to reader (`apps/web/browser/journeys/`).

Three things stand in for the outside world:

- **Turnstile's script**, inside the browser. It solves every widget at once and draws no frame, so the CSP's `frame-src` goes unexercised.
- **R2's S3 endpoint**, for the browser's presigned PUT: a small Worker (`harness/r2-put.ts`) that answers the CORS preflight, signs the URL again with `presignPut` and refuses a mismatch, then stores the body in the shared bucket. It is not R2. R2's own signature check and the bucket's CORS rule are shown only by a deploy.
- **Email's consumer**, a sink that `site.emails()` reads.
- **The Workers' own outbound network**: web's siteverify and purge calls get `test/stand-ins.ts`'s answers, and anything else any Worker fetches gets a 599.

Any other HTTP request a page makes off the site is refused and recorded in `site.offSite`. A Worker's blocked fetch isn't recorded there, and WebSockets aren't intercepted.

**Getting the browser.** `npm ci` downloads no browser. Install Playwright's Chromium once per checkout, and again whenever the `playwright` version in `apps/web/package.json` changes:

```sh
npx playwright install chromium                # a developer machine
npx playwright install --with-deps chromium    # Linux CI: also installs the system libraries
```

Headless runs need only the headless shell, so CI may use `npx playwright install --with-deps --only-shell chromium`. The browser goes to `%LOCALAPPDATA%\ms-playwright` on Windows, `~/Library/Caches/ms-playwright` on macOS and `~/.cache/ms-playwright` on Linux; cache that folder in CI. To put it elsewhere, set `PLAYWRIGHT_BROWSERS_PATH` both when installing and when running. Without the browser the suites fail, saying how to install it; they never skip.

**Options.** `BROWSER_VIEWPORT=360x640 npm run test:browser` opens every site's pages in a 360 by 640 window (the default is 1280 by 800; the checker self-tests set their own). It changes the window only: the 360 px sideways-scroll check is `hasSidewaysScroll`, which `browser/layout/sideways.browser.test.ts` calls on every inventory page in a 360 by 640 window of its own, whatever this option says. One file: `npx vitest run -c vitest.browser.config.ts browser/a11y/wcag.browser.test.ts` from `apps/web`. Don't run it alongside `npm test`: both start workerd, and the web tests' first requests slow down under load.

**Recording.** `BROWSER_RECORD=<absolute dir> npm run test:browser` saves one WebM per page a test opens on a site into `<dir>` (the checker self-tests have no site, so no videos), with Playwright's `recordVideo`, named for the test (`-2`, `-3` for further pages in one test; a rerun overwrites, and so does another test with the same describe and test names). So a journey should open one page. The harness's own sign-in page is left out. The videos show the page only, with no browser chrome, and all text in them is synthetic; `<dir>` is yours, so keep it outside the repository and commit no videos. `site.close()` fails on a file over 10 MB. While recording, Chromium runs with Playwright's `slowMo` of 750 ms (`SLOW_MO_MS`, `recording.ts`), which delays each click, fill and navigation (not reads or `evaluate`) so a video can be followed; wait for an event with `Promise.all([page.waitForEvent(...), action])`, never after the action. Unset, nothing starts the recorder and normal runs aren't slowed.

**Adding a browser suite.** Put it in its own folder under `apps/web/browser/` (`a11y/` holds the accessibility suites, `journeys/` the journeys), in a file named `*.browser.test.ts`. The pieces are in `apps/web/browser/harness/`:

- `startSite({ prelaunch, viewport })` (`site.ts`) starts the Workers (bundled once per run, `global-setup.ts`), their database and Chromium, on free ports. Each file starts its own in `beforeAll` and calls `site.close()` in `afterAll`; files run side by side. `a11y/inventory-suite.ts` shows the pattern for a suite over the whole inventory.
- `useJourneySite()` (`journey.ts`) does that for a journey, and fails every test in its block on a CSP violation, a console or script error or an unexpected off-site request. It calls `site.assertClean()` (`clean.ts`) after each test and closes the contexts the test opened; a test that expects a problem, such as an error page's own status line, calls `await site.assertClean({ allow: [/status of 404/] })` itself first.
- `uploadThroughPage(site, page, userId, syntheticEpub(name))` (`journey.ts`) uploads a fixture from `fixtures/epubs/synthetic/` through `/upload` and returns the upload's id. Then `site.waitForUpload(id)` waits for ingest: it polls the upload's row, so never sleep for a fixed time. It resolves at `live` (or the status you pass), which ingest writes last, and throws at once, naming the status, if the job ends any other way. Ingested works keep the ids inside the fixtures (1000101 to 1000105), and a second upload of one fixture to the same site is a duplicate.
- `site.newContext()` opens a signed-out browser context; `signedIn(site, { email, role })` (`sessions.ts`) signs an account in through the Worker and returns a context holding its session. `role` is `reader`, `uploader` or `moderator`; `acceptTerms: false` leaves a new account.
- `seedReadableWork(site, options)` (`seed.ts`) seeds a work through `@archive/db/seed`, as the workerd tests do, and writes its chapters to the bucket; `seedInventory` seeds what the page inventory needs. `site.db` is the Worker's database, `site.emails()` what it has emailed.
- `OPEN_PAGES` and `PRELAUNCH_PAGES` (`pages.ts`) list the page inventory; `visit` (`visit.ts`) opens one as its visitor. `hasSidewaysScroll(page)` (`layout.ts`) is the 360 px check.

One database serves a site, so give each site's seeds their own AO3 work id block and email addresses. Text in tests is synthetic.
