# solid-octo-guacamole

## Tests

From the repository root, after `npm ci`:

| Command | Runs |
|---|---|
| `npm test` | Every workspace's Vitest suites (Node, and workerd through `@cloudflare/vitest-plugin`), then `scripts/*.test.mjs`. Needs no browser. |
| `npm run test:browser` | The browser suites in `apps/web/browser/`: headless Chromium against the web Worker. Not part of `npm test`. Under a minute. |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` | The other standing checks. |

### The browser suites

`npm run test:browser` bundles the web Worker as `wrangler deploy` would, runs it in Miniflare on a fresh PGlite database, and drives headless Chromium against it. Chromium visits `https://rarepair.fans`, which it resolves to the local Worker, so the Worker's same-origin checks, its `__Secure-` session cookie (accounts sign in through the real form and link) and its CSP apply as in production. Turnstile and the content host are stood in for inside the browser, and any other request off the site is refused; the Turnstile stand-in draws no frame, so the CSP's `frame-src` goes unexercised. Today they check spec 21's WCAG 2.2 AA and keyboard cases (`apps/web/browser/a11y/`).

**Getting the browser.** `npm ci` downloads no browser. Install Playwright's Chromium once per checkout, and again whenever the `playwright` version in `apps/web/package.json` changes:

```sh
npx playwright install chromium                # a developer machine
npx playwright install --with-deps chromium    # Linux CI: also installs the system libraries
```

Headless runs need only the headless shell, so CI may use `npx playwright install --with-deps --only-shell chromium`. The browser goes to `%LOCALAPPDATA%\ms-playwright` on Windows, `~/Library/Caches/ms-playwright` on macOS and `~/.cache/ms-playwright` on Linux; cache that folder in CI. To put it elsewhere, set `PLAYWRIGHT_BROWSERS_PATH` both when installing and when running. Without the browser the suites fail, saying how to install it; they never skip.

**Options.** `BROWSER_VIEWPORT=360x640 npm run test:browser` opens every site's pages in a 360 by 640 window (the default is 1280 by 800; the checker self-tests set their own). It changes the window only: the 360 px sideways-scroll check is `hasSidewaysScroll`, which a suite calls (Q1c, #510). One file: `npx vitest run -c vitest.browser.config.ts browser/a11y/wcag.browser.test.ts` from `apps/web`. Don't run it alongside `npm test`: both start workerd, and the web tests' first requests slow down under load.

**Adding a browser suite.** Put it in its own folder under `apps/web/browser/` (`a11y/` holds the accessibility suites), in a file named `*.browser.test.ts`. The pieces are in `apps/web/browser/harness/`:

- `startSite({ prelaunch, viewport })` (`site.ts`) starts the Worker (bundled once per run, `global-setup.ts`), its database and Chromium, on free ports. Each file starts its own in `beforeAll` and calls `site.close()` in `afterAll`; files run side by side. `a11y/inventory-suite.ts` shows the pattern for a suite over the whole inventory.
- `site.newContext()` opens a signed-out browser context; `signedIn(site, { email, role })` (`sessions.ts`) signs an account in through the Worker and returns a context holding its session. `role` is `reader`, `uploader` or `moderator`; `acceptTerms: false` leaves a new account.
- `seedReadableWork(site, options)` (`seed.ts`) seeds a work through `@archive/db/seed`, as the workerd tests do, and writes its chapters to the bucket; `seedInventory` seeds what the page inventory needs. `site.db` is the Worker's database, `site.emails()` what it has emailed.
- `OPEN_PAGES` and `PRELAUNCH_PAGES` (`pages.ts`) list the page inventory; `visit` (`visit.ts`) opens one as its visitor. `hasSidewaysScroll(page)` (`layout.ts`) is the 360 px check.

One database serves a site, so give each site's seeds their own AO3 work id block and email addresses. Text in tests is synthetic.
