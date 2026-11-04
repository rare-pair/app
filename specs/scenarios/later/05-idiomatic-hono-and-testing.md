# Scenario: Hono and test code follow one idiom, or say why not

Relates to: docs/ARCHITECTURE.md § Decisions so far, § Repo layout (the "Hono's JSX" line); docs/process.md § Working rules; `.claude/skills/tdd/` (SKILL.md, tests.md, mocking.md), which stays the authority on seams, mocking and test names and is not restated here; issues #232, #211, #107, #235, #241

Status: draft. R1 and R2 are decided (below). Nothing here changes what a reader, uploader or moderator sees. The bytes of a page do change under R1 (`<input/>`, `defer=""`), but what a browser parses from them doesn't.

"Idiomatic" here means the framework's documented form, unless that form loses a behaviour this repo has tested on purpose. Where it does, the repo's form stays and the reason is written down, so nobody "fixes" it later. The claims about Hono's behaviour were run against the pinned version (see *Measured*), since the docs leave out some of what decides these cases, such as what `csrf`'s refusal becomes under this repo's `onError`.

## Setup
- `hono` 4.13.14, `vitest` 4.1, `@cloudflare/vitest-plugin` 1.4, `playwright` 1.64, as `package.json` pins them; measured at commit 73b4b15
- Hono is used by `apps/web` only. `apps/content`, `apps/ingest`, `apps/mailer` and `apps/sweep` have no Hono code, so the Hono cases are about `apps/web`
- "The guard test" is `scripts/idioms.test.mjs` (case *A guard test keeps these rules true*). `npm run test:scripts` runs it, and so `npm test` does too
- Each THEN that names a count is checked by the guard test or by the grep given

## Rulings to make

These change the work items. Cases that depend on one say so.

### R1: How pages build HTML (decided by the operator, 2026-11-04: Hono JSX)
`docs/ARCHITECTURE.md` says "server-rendered with Hono's JSX". The line is prose, not in the *Decisions so far* table, and the code has never done it: there are no `.tsx` files, and pages are template strings with 110 `escapeHtml(` calls across 17 files. A forgotten call is an injection, with the CSP as the only backstop.

The pages move to JSX, for readability and for building UI from checked components, as well as for automatic escaping. The `html` tag from `hono/html` was the cheaper option: it escapes the same way and keeps today's markup, so no test would have changed. It was passed over because it gives no components or type-checked props, and because the tests that would have kept it cheap are the problem: a test shouldn't fail because `<input>` became `<input/>`.

So the tests move first, while the pages are still template strings. They then pass before and after JSX, which is the proof that behaviour didn't change. JSX doesn't make a `javascript:` URL safe: `href` still needs the existing checks.

### R2: How routes are organised (decided by the operator, 2026-11-04: Hono's guideline)
Hono's best-practices page says not to write controllers, because `(c: Context) => ...` loses the path parameter's type, and to split a larger app into feature routers mounted with `app.route()`. `apps/web` has both styles today: `src/index.ts` registers 36 named handlers and `admin.ts` 5, while the other admin routers (`admin-items.ts` and others) are already inline.

Every route follows the guideline, for one form throughout. Keeping the table was the cheaper option: only 14 of 35 `c.req.param` sites would gain a type, and it kept each route beside its guard. The cases below keep what the table gave: the middleware order stays in one file, and a test now proves each POST route's guard, since a guard and its handler will be in different files.

The docs' other suggestion, `factory.createHandlers`, isn't used: it left `c.req.param("id")` as `string | undefined` when measured.

## Cases

### Kept on purpose: the built-ins this repo doesn't use

#### The same-origin check stays stricter than `hono/csrf`
- GIVEN a POST to a guarded route with `Origin: https://evil.example` and `Sec-Fetch-Site: same-origin`, or with `Origin: https://rarepair.fans` and `Sec-Fetch-Site: cross-site`, or with a JSON content type and either header naming another site
- WHEN it is sent through `exports.default.fetch`
- THEN it is refused, with the route's own refusal page or JSON as today
- AND a test shows each of those rows (`hono/csrf` allows all of them)
- AND the guard test finds no import of `hono/csrf`

#### Security headers stay the repo's own
- GIVEN the strict CSP, keyed on path and set on HTML only, and the HSTS value in `src/security.ts`
- WHEN any page is requested
- THEN its headers are as `test/helpers.ts`'s `STRICT`, `TURNSTILE` and `UPLOAD_CSP` say
- AND the guard test finds no import of `hono/secure-headers`
- AND whether to widen them stays with #107, which this scenario doesn't decide

#### Form bodies stay read by `readForm`
- GIVEN a `multipart/form-data` POST to `/login`
- WHEN it is sent
- THEN the body is never read, and the request is treated as having no fields
- AND a streamed body over a route's limit is refused without being read to its end
- AND a test shows both: no test in `apps/web/test` sends multipart today
- AND the guard test finds no `parseBody`, `hono/body-limit` or `hono/validator` in `apps/web/src`

#### Cookies stay written by hand, and read with `getCookie`
- GIVEN `SETTINGS_COOKIE_ATTRIBUTES`, which the server and the settings script in the browser both use
- WHEN the server sets the settings cookie
- THEN `Set-Cookie` goes through `c.header(..., { append: true })`, as today
- AND `docs/ARCHITECTURE.md` says why: `setCookie` encodes the value and the browser script writes it raw, so moving the server alone leaves two spellings of one cookie

#### Handlers refuse by returning, never by throwing `HTTPException`
- GIVEN `app.onError` answers every error with a logged 500
- WHEN a handler or middleware refuses a request
- THEN it returns the response
- AND the guard test finds no `hono/http-exception` in `apps/web/src`
- AND a later change that adds a built-in which throws it also makes `onError` answer with `getResponse()`, with a test, in the same PR: today such a refusal would become a 500

#### GET routes also serve HEAD
- GIVEN Hono answers HEAD from the GET route and never calls a HEAD handler
- WHEN the guard test scans `apps/web/src`
- THEN it finds no `app.head` or `.on("HEAD"`

#### A route pattern doesn't replace the ID parser
- GIVEN `/works/:id{[1-9]\d{0,9}}` also matches `/works/%31`, because Hono decodes the path segment before testing it
- WHEN #211 and #235 settle how work IDs are parsed
- THEN a test shows `/works/%31` gets their answer, whichever form the route takes

#### Tests reach a Worker through its fetch entry
- GIVEN Hono's testing page recommends `app.request(path, init, MOCK_ENV)`, and `/tdd` forbids mocking bindings
- WHEN a test exercises a Worker's HTTP surface
- THEN it goes through `exports.default.fetch`, Cloudflare's documented form, with the deployed `wrangler.jsonc`
- AND `.claude/skills/tdd/SKILL.md` says so by name, so a reader of Hono's docs doesn't reach for `app.request`
- AND `app.request` is used only on a throwaway `new Hono()` for a middleware with no bindings, in a Node test, at an agreed seam, and the guard test finds no third argument passed to it

### Tests stop depending on how markup is spelled (before any page moves)

#### Structure is asserted on parsed HTML
- GIVEN 359 lines in `apps/web/test`, across 50 files, that assert on markup as a string (224) or pull values out of it with a regular expression (135)
- WHEN a batch moves onto a helper in `test/helpers.ts` that parses the response
- THEN a form's `action`, `method` and hidden fields, a script's `nonce`, the page's `h1`, labels and links are read as elements and attributes
- AND a check of text alone, with no markup in it, stays as it is
- AND the batch passes against today's template-string pages, with no change in `apps/web/src`
- AND for each file, the PR shows one moved assertion going red when the page it checks is broken on purpose
- AND the guard test finds no markup literal in an assertion in a moved file, apart from the listed exceptions

The first ticket chooses the parser, by trying it in the workerd projects. `HTMLRewriter` is built in and adds no dependency, but it is a streaming API. A parser library would read better, but it is a new dev dependency: none is in `package-lock.json` today. The ticket reports what it measured.

#### A negative assertion can't pass by accident
- GIVEN 70 of those lines are negative, such as `not.toContain('<input type="hidden" name="next"')`, and these keep passing once the spelling changes, whether or not the element is there
- WHEN one is moved
- THEN it reads the parsed page, in a test that also proves the page or its parent element is the one meant
- AND every negative is reviewed by hand, including those still green, since going red can't find them

#### Escaping is still checked on the raw response
- GIVEN a parser tidies what it reads, and the raw bytes are what a browser receives
- WHEN a test checks that a hostile value can't become markup
- THEN it asserts on the raw body: `<script>` absent, and `&lt;script&gt;` present where the value is shown
- AND these tests are the guard test's listed exceptions, with that reason
- AND sanitizer output tests in `packages/epub` and `apps/ingest` don't change

#### The no-JS browser reads parsed HTML
- GIVEN `test/no-js-browser.ts` reads forms and links with regular expressions, and its header comment defends that because the pages are "written one way", which stops being true
- WHEN it moves to the helper
- THEN the comment goes with the regular expressions
- AND its tests pass unchanged against today's pages

### Hono: what changes

#### One app env and one database lifecycle
- GIVEN #232 and #211, which already specify these
- WHEN they merge
- THEN no handler or page module restates the env, as the 24 `Bindings: Bindings` lines and the context aliases in 19 files do today; the shared type and `AdminEnv`, which adds to it, stay
- AND `createDb(` appears only in the shared helper, apart from the session lookup, whose connection #241 settles

#### One same-origin guard
- GIVEN three guard middlewares (`sameOriginOnly`, `sameOriginUpload`, `adminSameOrigin`) and six handlers that call `isSameOrigin` themselves
- WHEN the guard becomes one factory that takes the route's refusal
- THEN `isSameOrigin(` appears in `src/signin.ts` and the factory only
- AND every route refuses with the same status and body as before, the admin routes with their 404
- AND the existing same-origin tests pass unchanged
- AND the routes that move ahead of the session lookup cost no session lookup when refused

#### The hashed script routes share one handler
- GIVEN four script routes and the stylesheet route in `src/index.ts`, each repeating the same three headers
- WHEN they share one helper
- THEN `max-age=31536000` appears once in `src/index.ts`
- AND each response's status, body and headers are unchanged

#### Handlers read variables one way
- GIVEN 76 uses of `c.var.` and 13 of `c.get("`
- WHEN they are made one
- THEN the guard test finds no `c.get("` in `apps/web/src`

#### Every POST route refuses a cross-site post (R2, before any route moves)
- GIVEN a guard is registered by path in `src/index.ts` ahead of the session, its handler is about to move to another file, and a guard with a mistyped path silently guards nothing
- WHEN a test walks `app.routes` and sends each POST route a cross-site request
- THEN each answers with its refusal: 403, or for `/admin`, with a moderator's session, the app's 404
- AND a POST route added later is covered with no change to the test
- AND the app is built in `src/app.ts`, with `src/index.ts` keeping the default export, so the test can read `app.routes` and nothing extra is exported from the Worker's entry

#### Handlers are inline, in feature routers (R2)
- GIVEN a feature module (`report.ts`, `reader.ts` and so on) that exports named handlers for `src/index.ts` to register
- WHEN it moves
- THEN it exports a `new Hono<AppEnv>()` whose handlers are written inline at their paths, in the statement form `admin-items.ts` uses (chaining is for RPC, which isn't used), and `src/index.ts` mounts it with `app.route()`
- AND every URL, method, status, body and header is as before, `/login/` still answering 404, and the existing tests pass unchanged
- AND a helper that takes `c` stays, and gets a path parameter as a value from its handler, as `workByAo3Id` already does
- AND once the last batch has merged, the ID parsers (`workId`, `positiveInt` and #211's shared one) take `string`, not `string | undefined`, so a handler that lost its path type fails `typecheck`
- AND the guard test finds no route whose last argument is a bare name, apart from the guards in `src/app.ts`, and no `hono/factory`

#### The order of middleware stays in one file (R2)
- GIVEN the order in `src/index.ts`, and its comments, are what keep www off the CSP, a refused post off the database, and the terms gate ahead of the settings
- WHEN routes move out
- THEN `src/app.ts` holds every `app.use`, the same-origin guards ahead of the session, and the `app.route()` list, in today's order, with those comments
- AND a guard doesn't move into its router, where it would run after the session lookup
- AND the routers come after the middleware, so each route passes through all of it, as before

#### A feature router has no middleware of its own (R2)
- GIVEN a router's `use()` also runs on every router mounted after it on the same base, as measured below, and several routers share `/works`
- WHEN the guard test scans `apps/web/src`
- THEN `.use(` appears only in `src/app.ts` and `src/admin.ts`
- AND `admin` stays the only router mounted on `/admin`, with its sub-routers mounted after its gate, so the gate covers them and nothing else
- AND a route that needs its own middleware names it between its path and its handler, as `requireSignIn` does today

#### JSX runs through every check the gate runs (R1)
- GIVEN `apps/web/tsconfig.json` includes only `src/**/*.ts` and `test/**/*.ts`
- WHEN the first `.tsx` file is added, with `"jsx": "react-jsx"` and `"jsxImportSource": "hono/jsx"`
- THEN `npm run lint`, `format:check`, `typecheck`, `test` and `build` each cover it
- AND a type error planted in that file fails `typecheck`, and a lint problem planted in it fails `lint`, so a check that silently skips `.tsx` is found
- AND a `.node.test.ts` that imports it still runs in the Node project

Only `tsc` was tried against these settings. Whether oxlint's type-aware rules, oxfmt, Vitest's Node project and `wrangler deploy --dry-run` all accept it is what this case finds out, and a problem with any of them goes to the operator before the batches start.

#### The entire work keeps streaming (R1)
- GIVEN `src/full.ts` sends each chapter as it is read, between the two halves `layoutAround` returns, and JSX can't express half a document
- AND `renderToReadableStream` sent two async components as one chunk when measured
- WHEN `full.ts` moves
- THEN `streamParts` stays, chapter fragments stay strings, and JSX builds only the pieces between them
- AND the first chapter is still read before the 200, and a reader who leaves still cancels the stream, as `test/full-stream.node.test.ts` shows
- AND the shell around the chapters comes from the same layout as every other page, not a second copy of it

How to split the rendered layout around the chapters isn't settled: this case runs early because a poor answer here changes how the layout is written. `Suspense` wasn't tried, and anything it adds would have to pass the CSP.

#### Pages render with JSX, leaf first (R1)
- GIVEN a page module that interpolates a reader's or uploader's value
- WHEN it moves to JSX
- THEN `"><script>` in that value comes out as `&quot;&gt;&lt;script&gt;`, as `escapeHtml` gives it
- AND the tests moved earlier pass with no assertion changed, and the browser suites (`npm run test:browser`) pass, the layout and accessibility checks included
- AND the order is leaf first: a JSX piece goes into a plain template as its markup, but a plain string of markup goes into a JSX parent escaped, so a parent moved before its child shows `&lt;` on the page
- AND a word beside an inline element keeps its space where the JSX breaks a line, since JSX drops a line break next to an element: `{" "}` is written where one is needed
- AND the components stay synchronous until a case needs otherwise, since a page's data is read in its handler

Once every batch has merged:
- `escapeHtml` is gone from `apps/web/src`, and the guard test checks it
- unescaped HTML (`raw(` or `dangerouslySetInnerHTML`) appears only for the sanitized chapter fragments and the doctype, each with a comment saying why it is safe, and the guard test checks that too
- the scripts and stylesheet served as strings (`*-script.ts`, `styles.ts`) stay as they are, since they aren't markup

The first batch settles how a JSX piece meets `layout`'s `body: string` while the layout is still a string, and the rest follow it.

### Testing: what changes

#### One way to fetch the Worker in `apps/web`
- GIVEN `test/11-reader-and-csp.test.ts` and `test/20-site-chrome.test.ts` keep their own copies of `fetchW`, which `test/helpers.ts` notes
- WHEN they use the shared one
- THEN no test file in `apps/web/test` defines `fetchW`
- AND `exports as any` appears at most once per workspace

#### A signed-in moderator comes from the helper
- GIVEN 20 test files make a moderator with their own `.set({ role ... })`, and the browser harness already has `signedIn` with a `role`
- WHEN `signIn` in `test/helpers.ts` takes a role
- THEN `set({ role` appears in `test/helpers.ts` only, apart from a test whose case is itself a change of role

#### Console capture has one helper per workspace
- GIVEN `consoleDuring` in `apps/web/test/helpers.ts`, with five web test files, three in `apps/ingest` and two in `apps/mailer` spying on the console themselves
- WHEN they move to a helper in their workspace
- THEN `spyOn(console` appears in one file per workspace

#### Waiting on something uses `vi.waitFor` or `expect.poll`
- GIVEN five hand-written deadline loops (`test/helpers.ts`, `test/02-upload-confirm.test.ts`, `browser/harness/sessions.ts`, `site.ts`, `waitlist.ts`), where the browser suites already use `expect.poll`
- WHEN they are replaced
- THEN no test helper combines `for (;;)` with a `Date.now()` deadline
- AND a timeout still fails naming what it waited for, as `emailsTo` does: `vi.waitFor` defaults to one second, so each call states its own timeout
- AND a loop that isn't waiting, such as reading a stream or paging a listing, stays

Unverified: that `vi.waitFor` behaves in the workerd projects as in Node. The ticket tries one helper first and reports what it measures.

#### Browser suites find elements as a person does
- GIVEN 119 `locator(` calls in `apps/web/browser`, 40 of them for `h1` or `main`, and Playwright's docs recommending role and label locators over CSS
- WHEN they are moved
- THEN `h1`, `main`, and form fields with a label use `getByRole` or `getByLabel`
- AND a locator with no user-facing handle, such as `li[data-upload-id=...]`, stays
- AND a test ID is the last resort, for an element with no such handle: role and label also show that a person or a screen reader can find it, and a test ID doesn't help the workerd tests, which have no DOM until the helper parses one
- AND `npm run test:browser` passes, with the same number of tests

#### A known failure names its issue
- GIVEN `it.fails("... (known failure: #405)")`, the form the browser journeys already use
- WHEN the guard test scans the test files
- THEN every `it.fails` title has `(known failure: #<n>)`, apart from the harness's test of its own failure handling
- AND no `.only(` or `.skip(` is committed (`skipIf` for an absent fixture stays, per `/tdd`)

#### AO3 test IDs can't collide (only if the audit finds a reason)
- GIVEN one database serves a whole run, and files reserve work IDs in comments (at least 29 such lines)
- WHEN a one-off audit lists the IDs each file seeds
- THEN any overlap is filed as a bug and fixed
- AND a registry and a guard check are added only if overlaps exist or the audit shows comments have drifted from the IDs in use

### Keeping it true

#### A guard test keeps these rules true
- GIVEN `scripts/idioms.test.mjs`, in the same `node --test` form as the other script tests
- WHEN a rule above is broken
- THEN `npm run test:scripts` fails, naming the file, the line and the rule
- AND an exception is a listed path with its reason, in that file
- AND a work item adds its check in the PR that makes it true, so the file never holds a rule the code doesn't yet meet

#### The rules are where agents read them
- GIVEN engineers read `/tdd` and `docs/ARCHITECTURE.md`, not this scenario
- WHEN the kept deviations are written down
- THEN `docs/ARCHITECTURE.md` lists each built-in not used, with its reason, says routes are feature routers mounted from `src/app.ts`, and keeps its "Hono's JSX" line, now true
- AND `.claude/skills/tdd/` gains the `app.request` rule, parsed HTML for structure and raw bytes for escaping, `vi.waitFor` and `expect.poll` for waits, role-first locators with test IDs last, and the known-failure form
- AND nothing it says already is repeated

## Out of scope
- **Text-only assertions.** A `toContain` of a sentence already checks content, not spelling, and stays.
- **Renaming existing tests.** `/tdd` keeps existing names, though some `describe`s have drifted from their scenario file (`19-surge-controls` against `19-surge-controls-and-quotas`).
- **Real-time waits around the local rate limiter** (`windowHeadroom`). Its windows are aligned to the clock, and the waits exist for that reason.
- **Moving the browser suites to `@playwright/test`.** They run Playwright under Vitest by design (Q1b's harness).
- **`new Response` in handlers** (five sites). Some carry Better Auth's headers; there's no gain until one causes a problem.
- **`createMiddleware` in place of `MiddlewareHandler<E>`.** Both type the middleware, and Hono's own middleware returns `MiddlewareHandler`.
- **The mailer's `vi.spyOn(globalThis, "fetch")`.** `mocking.md` says senders are injected stubs, and the web Worker uses Miniflare's `outboundService`. Worth its own follow-up, since it is a design change to the mailer rather than an idiom swap.

## Work items

For `/to-tickets`. Sized so most run on a cheaper model, and sequenced so no two change the same `apps/web/src` files at once. The test-only items can run beside the source items.

| # | Item | Touches | Size | Tier | Depends on |
|---|---|---|---|---|---|
| 1 | Guard test with the rules already true; docs and `/tdd` additions | `scripts/`, `docs/`, `.claude/skills/tdd/` | S | 2 | none |
| 2 | Tests for the kept boundaries (same-origin rows, multipart) | `apps/web/test` | S | 2 | 1 |
| 3 | #232 (env type, database lifecycle) | most of `apps/web/src` | M | 3 | 1 |
| 4 | #211 (ID parser) | `report`, `reader`, `work-page` and others | S | 3 | 3 |
| 5 | One same-origin guard | the 9 files that use it, and `index.ts` | S | 3 | 3 |
| 6 | Script route helper; `c.var` | `index.ts`, and 13 sites | XS | 2 | 5 |
| R2a | `src/app.ts`; the test that walks every POST route | `index.ts`, `app.ts`, one test file | S | 3 | 5, 6 |
| R2b to R2h | Routers, one at a time since each edits `src/app.ts`: admin home and queues; sign-in and terms; uploads; reader, work page, warnings, position, settings; listing and search; removal, DMCA, reports; wait list and site pages. The last also narrows the ID parsers | one group each | S each | 3 | 4, R2a, then in order |
| 7 | Parsed-HTML helper: choose the parser, move one test file as the tracer | `test/helpers.ts`, one test file | S | 2 | 1 |
| 8a to 8e | Move structural and negative assertions, by scenario: 01 to 03; 08 to 13; 14 to 17; 18; 20 to 23 | one group of `apps/web/test` each | S to M each | 2 | 7; the five can run side by side |
| 9 | `test/no-js-browser.ts` on the helper | that file and the tests using it | S | 2 | 7; not beside 8e, which shares the no-JS tests |
| 10 | JSX tracer: tsconfig, tooling, one small page | `apps/web/tsconfig.json`, one module | S | 3 | R2h, 8a to 8e, 9 |
| 11 | Entire-work trial, including how the layout splits | `full.ts`, `pages.ts` | S | 3 | 10 |
| 12a to 12f | R1 batches, leaf first: admin pages; listing, search, home; reader, work page, warnings; forms (DMCA, remove, report, settings); uploads and wait list; then the layout and removing `escapeHtml` | one group each | S to M each | 3 | 11, then in order |
| 13 | `fetchW` copies; `signIn` with a role | `apps/web/test` | S | 2 | Before or after 8a to 8e, not during |
| 14 | Console helpers | `apps/*/test` | XS | 2 | 1 |
| 15 | `vi.waitFor` and `expect.poll` | test helpers, `browser/harness` | S | 2 | 1 |
| 16 | Browser locators | `apps/web/browser` | S | 2 | 1 |
| 17 | AO3 ID audit | read only, unless it finds overlaps | XS | 2 | none |

Items 8a to 8e are sized from line counts, not from reading each assertion, so 7 re-sizes them once the tracer shows how much a file takes. The routers come before JSX so that no diff both moves a handler and rewrites its markup: a pure move is what the unchanged tests can vouch for. The test items 7 to 9 and 13 to 17 can run beside the routers, since they stay out of `apps/web/src`.

## Measured

Run on the pinned versions outside the repo. Docs are hono.dev, developers.cloudflare.com, vitest.dev and playwright.dev, read 2026-11-04.

| Claim | Result |
|---|---|
| `hono/csrf` against `isSameOrigin` | 11 header pairs across 5 content types: they disagree on 16 of 55, always with `csrf` allowing. It allows when either header passes, and doesn't check JSON |
| `csrf`'s refusal under this repo's `onError` | A 500 "Internal Server Error", because it throws `HTTPException`. Alone, it is a plain-text 403 |
| `secureHeaders` | Sets its CSP on JSON too, and adds `X-Frame-Options`, `Cross-Origin-Resource-Policy` and others the app doesn't send today. Its `Referrer-Policy: no-referrer` applies to every response, where the app sets its own per route (`strict-origin` on the token pages, for one) |
| `parseBody` behind `bodyLimit` | A streamed body over the limit gets a 413, as `readForm` refuses it, but a multipart body is read, where `readForm` never reads one |
| Feature routers: order | A guard on the parent before the session, with its handler in a router mounted later, ran hsts, guard, session, page state, handler. A refusal stopped at the guard |
| Feature routers: answers | `c.notFound()` and a throw inside a router reach the parent's `notFound` and `onError`. `/login` from a router's `/` gives 200, and `/login/` gives 404. Two routers can share a base. HEAD works. `app.routes` lists mounted routes by full path |
| A router's `use()` on a shared base | Runs on routers mounted after it: `/x/r` went through a gate that belonged to another router on `/x`. Mounted the other way round, it didn't |
| Path held in a constant | A `const` literal, like `SETTINGS_PATH`, keeps the parameter's type. A path typed `string` loses it. Middleware between path and handler keeps it |
| `html` tag, the option not taken | Identical to `escapeHtml` on `a&b<c>d"e'f`. Keeps `<input ...>` |
| Hono JSX: escaping | Identical to `escapeHtml` on `a&b<c>d"e'f`, in text and in attributes. A `javascript:` URL passes through unchanged |
| Hono JSX: output | `<input .../>`, `<br/>`, and `defer=""` for a boolean attribute. `disabled={false}` is left out. `null`, `undefined`, `false` and `""` render nothing, and `0` renders `0`. A line break inside text becomes one space |
| Hono JSX: the doctype | Can't be written as JSX. Both ``html`<!doctype html>${...}` `` and `raw("<!doctype html>")` work, and `c.html` sends either as `text/html` |
| JSX mixed with strings | A JSX piece in a plain template gives its markup, with a cast for TypeScript. A string of markup in a JSX parent comes out escaped, and goes through with `raw` or `dangerouslySetInnerHTML` |
| `renderToReadableStream` | Two async components came out as one chunk |
| Markup assertions, `apps/web/test` | 224 lines assert on it (70 of them negative), 135 more extract from it, in 50 files. 51 lines name a void element. Counted by pattern, not read one by one, so these are sizes rather than exact totals |
| `c.req.param("id")` type | `string` inline, in a sub-router and in `Context<E, "/works/:id">`. `string \| undefined` in a plain `Context<E>`, **and in `createHandlers`, which the docs offer as the typed form** |
| `Context<E, "/works/:id">` mounted on `/tags/:name` | Compiles, so a path-typed controller doesn't check its own mount |
| Type checks | Repo's `tsconfig` settings; a negative control fails as it should |
| A non-`Error` throw | Escapes `app.fetch`, skipping `onError` and the headers set after `next()`: #107's first point still holds on this version |
| Route pattern `:id{[1-9]\d{0,9}}` | `12` gives 200, and `012` and `x` give 404. `%31` gives 200, with the param decoded to `1` |
