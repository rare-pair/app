# Scenario: Hono and test code follow one idiom, or say why not

Relates to: docs/ARCHITECTURE.md § Decisions so far, § Repo layout (the "Hono's JSX" line); docs/process.md § Working rules; `.claude/skills/tdd/`, which stays the authority on seams, mocking and test names and is not restated here; issues #232, #211, #107, #235, #241

Status: draft. R1 and R2 are decided (below). Nothing here changes what a reader, uploader or moderator sees, except the cross-site refusal the guard case names. The bytes of a page do change under R1 (`<input/>`, `defer=""`), but what a browser parses from them doesn't.

"Idiomatic" here means the framework's documented form, unless that form loses a behaviour this repo has tested on purpose. Where it does, the repo's form stays and the reason is written down, so nobody "fixes" it later. The claims about Hono's behaviour were run against the pinned version (see *Measured*), since the docs leave out some of what decides these cases, such as what `csrf`'s refusal becomes under this repo's `onError`.

## Setup
- `hono` 4.13.14, `vitest` 4.1, `@cloudflare/vitest-plugin` 1.4, `playwright` 1.64, `oxlint` 1.90, as `package.json` pins them; measured at commit 73b4b15
- Hono is used by `apps/web` only, so the Hono cases are about `apps/web`
- A rule is enforced by `npm run lint` where oxlint can say it, and otherwise by an "idiom check": one test per rule at `apps/web/test/idioms/<rule>.node.test.ts`, which `npm test` runs (case *The rules enforce themselves*)

## Rulings

### R1: How pages build HTML (decided by the operator, 2026-11-04: Hono JSX)
`docs/ARCHITECTURE.md` says "server-rendered with Hono's JSX". The line is prose, not in the *Decisions so far* table, and the code has never done it: there are no `.tsx` files, and pages are template strings with `escapeHtml` calls. A forgotten call is an injection, with the CSP as the only backstop.

The pages move to JSX, for readability and for building UI from checked components, as well as for automatic escaping. The `html` tag from `hono/html` was the cheaper option: it escapes the same way and keeps today's markup, so no test would have changed. It was passed over because it gives no components or type-checked props, and because the tests that would have kept it cheap are the problem: a test shouldn't fail because `<input>` became `<input/>`.

So the tests move first, while the pages are still template strings. They then pass before and after JSX, which is the proof that behaviour didn't change. JSX doesn't make a `javascript:` URL safe: `href` still needs the existing checks.

### R2: How routes are organised (decided by the operator, 2026-11-04: Hono's guideline)
Hono's best-practices page says not to write controllers, because `(c: Context) => ...` loses the path parameter's type, and to split a larger app into feature routers mounted with `app.route()`. `apps/web` has both styles today: `src/index.ts` and `admin.ts` register named handlers, while the other admin routers (`admin-items.ts` and others) are already inline.

Every route follows the guideline, for one form throughout. Keeping the table was the cheaper option, since few `c.req.param` sites would gain a type. The docs' other suggestion, `factory.createHandlers`, isn't used: it left `c.req.param("id")` as `string | undefined` when measured.

## Cases

### Kept on purpose: the built-ins this repo doesn't use

#### The same-origin check stays stricter than `hono/csrf`
- GIVEN a POST with `Origin: https://evil.example` and `Sec-Fetch-Site: same-origin`, or with `Origin: https://rarepair.fans` and `Sec-Fetch-Site: cross-site`
- WHEN `isSameOrigin` reads its headers
- THEN it refuses, and `test/signin.node.test.ts` has both rows (`hono/csrf` allows both)
- AND a route-level test shows a JSON content type with another site's `Origin` refused, which `hono/csrf` doesn't check
- AND `npm run lint` refuses an import of `hono/csrf`, with the reason as its message

#### Security headers stay the repo's own
- GIVEN the strict CSP, keyed on path and set on HTML only, the HSTS value in `src/security.ts`, and the `Referrer-Policy` set route by route
- WHEN any page is requested
- THEN its headers are as `test/helpers.ts`'s `STRICT`, `TURNSTILE` and `UPLOAD_CSP` say
- AND `npm run lint` refuses an import of `hono/secure-headers`
- AND whether to widen them stays with #107, which this scenario doesn't decide

#### Form bodies stay read by `readForm`
- GIVEN a `multipart/form-data` POST to `/login`
- WHEN it is sent
- THEN the body is never read, and the request is treated as having no fields, as a new test shows: no test in `apps/web/test` sends multipart today
- AND `npm run lint` refuses an import of `hono/body-limit` or `hono/validator`, and an idiom check finds no `parseBody` in `apps/web/src`

#### Cookies stay written by hand, and read with `getCookie`
- GIVEN `SETTINGS_COOKIE_ATTRIBUTES`, which the server and the settings script in the browser both use
- WHEN the server sets the settings cookie
- THEN `Set-Cookie` goes through `c.header(..., { append: true })`, as today, because `setCookie` encodes the value and the browser script writes it raw, so moving the server alone leaves two spellings of one cookie

#### Tests reach a Worker through its fetch entry
- GIVEN a test of a Worker's HTTP surface
- WHEN it sends a request
- THEN it goes through the seam `/tdd` names, not `app.request(path, init, MOCK_ENV)`, which Hono's testing page recommends and which would mock the bindings
- AND `/tdd` says so by name, so a reader of Hono's docs doesn't reach for it

### Hono: what changes

#### `onError` passes on an `HTTPException`
- GIVEN Hono's built-ins refuse by throwing `HTTPException`, and `app.onError` turns every error into a 500
- WHEN a handler throws one
- THEN `onError` answers with its `getResponse()`, and a test on a throwaway app shows it
- AND any other error is still a 500 that logs only the error's kind
- AND the app's own handlers keep refusing by returning a response

#### One same-origin guard, on every POST by default
- GIVEN three guard middlewares, eight guard registrations listed by path, six handlers that call `isSameOrigin` themselves, and a mistyped path guarding nothing, silently
- WHEN they become one `app.on("POST", "*", ...)` ahead of the session
- THEN a POST route is guarded by being a POST route, and a new one needs no registration
- AND each area keeps its refusal, from one small lookup by path: the forbidden page, the wait list's page, uploads' JSON, and `/admin`'s 404
- AND `POST /waitlist/unsubscribe` is the one named exemption: it has no origin check today, and a test shows it stays reachable cross-site
- AND a refused post costs no session lookup, on every route
- AND one test per refusal, plus the exemption, shows the status and body as before
- AND the one change a visitor could see is stated, not hidden: a cross-site POST to a URL that doesn't exist now answers 403, not 404. `/admin` still answers 404, so it doesn't show that it exists
- AND a refusal answered ahead of `pageState` no longer carries the reader's settings attributes, as a cross-site report already doesn't

#### A shared env and database helper
- GIVEN #232 specifies these
- WHEN it merges
- THEN `AppEnv` is exported and `withDb` owns the lifecycle, apart from the session lookup, whose connection #241 settles
- AND the context aliases go with the router batches, which delete those lines anyway

#### Smaller repetition
- GIVEN four script routes and the stylesheet route repeat the same three headers, and handlers read variables both as `c.var` and `c.get`
- WHEN they are made one
- THEN the five routes share one helper, with each response unchanged
- AND an idiom check finds no `c.get(` in `apps/web/src`, added when the last router batch has merged

### Routes (R2)

#### Handlers are inline, in feature routers
- GIVEN a feature module (`report.ts`, `reader.ts` and so on) that exports named handlers for `src/index.ts` to register
- WHEN it moves
- THEN it exports a `new Hono<AppEnv>()` whose handlers are written inline at their paths, in the statement form `admin-items.ts` uses (chaining is for RPC, which isn't used), and `src/index.ts` mounts it with `app.route()`
- AND every URL, method, status, body and header is as before, `/login/` still answering 404, and the existing tests pass unchanged
- AND a helper that takes `c` stays, and gets a path parameter as a value from its handler, as `workByAo3Id` already does
- AND once every batch has merged, the ID parsers take `string`, not `string | undefined`, so a handler that lost its path type fails `typecheck`
- AND an idiom check finds no route whose last argument is a bare name, and `npm run lint` refuses `hono/factory`

#### Middleware stays in `src/index.ts`
- GIVEN the order in `src/index.ts`, and its comments, keep www off the CSP, a refused post off the database, and the terms gate ahead of the settings
- AND a router's `use()` also runs on every router mounted after it on the same base, as measured, and several routers share `/works`
- WHEN routes move out
- THEN `src/index.ts` keeps every `app.use` and the guard, in today's order and with those comments, and mounts the routers after them
- AND an idiom check finds `.use(` only in `src/index.ts` and `src/admin.ts`
- AND `admin` stays the only router mounted on `/admin`, with its sub-routers mounted after its gate
- AND a route that needs its own middleware names it between its path and its handler, as `requireSignIn` does today

### Tests stop depending on how markup is spelled (before any page moves)

#### Structure is asserted on parsed HTML
- GIVEN a test in `apps/web/test` that asserts on markup as a string, or pulls values out of it with a regular expression
- WHEN it moves to the parsed helper
- THEN a form's `action`, `method` and hidden fields, a script's `nonce`, the page's `h1`, labels and links are read as elements and attributes
- AND a check of text alone, with no markup in it, stays as it is
- AND the batch passes against today's template-string pages, with no change in `apps/web/src`
- AND for each page module and kind of assertion, the PR shows one moved assertion going red when the page is broken on purpose
- AND the helper grows from the API in `test/no-js-browser.ts` (`forms`, `links`, `attr`, `scriptTags`, `h1Text`), so its three test files keep working, and the file's comment defending regular expressions goes with them
- AND once the last batch has merged, an idiom check finds no markup literal in an assertion, outside the helper's own file

The first ticket chooses the parser, by trying each in the workerd projects and counting what each costs. `packages/epub/src/dom.ts` already builds a tree over `HTMLRewriter`, but it isn't exported, it is sanitizer internals, its attributes are undecoded, and it needs workerd. A parser library is a new dev dependency, in a PR of its own since that is tier 3. `HTMLRewriter` directly is built in, but it is asynchronous, which would change every call site of the no-JS API.

#### A negative assertion can't pass by accident
- GIVEN a negative such as `not.toContain('<input type="hidden" name="next"')` keeps passing once the spelling changes, whether or not the element is there
- WHEN one is moved
- THEN it goes through a handle that throws when its parent is absent, such as `form(action)` or `within(selector)`, so the helper can't express a vacuous negative
- AND every negative is reviewed by hand as it moves, including those still green, since going red can't find them

#### Escaping is still checked on the raw response
- GIVEN a parser tidies what it reads, and the raw bytes are what a browser receives
- WHEN a test checks that a hostile value can't become markup
- THEN it uses one helper, `expectEscaped(res, value)`, which asserts on the raw body
- AND sanitizer output tests in `packages/epub` and `apps/ingest` don't change

### JSX (R1)

#### JSX runs through every check the gate runs
- GIVEN `apps/web/tsconfig.json` includes only `src/**/*.ts` and `test/**/*.ts`
- WHEN the first `.tsx` file is added, a module with no routes such as `review-notice.ts`, with `"jsx": "react-jsx"` and `"jsxImportSource": "hono/jsx"`
- THEN each of `/gate` §3's checks covers it
- AND a type error planted in that file fails `typecheck`, and a lint problem planted in it fails `lint`, so a check that silently skips `.tsx` is found
- AND a `.node.test.ts` that imports it still runs in the Node project

Only `tsc` was tried against these settings. A problem with oxlint, oxfmt, Vitest's Node project or `wrangler deploy --dry-run` goes to the operator before the batches start.

#### The entire work keeps streaming
- GIVEN `src/full.ts` sends each chapter as it is read, between the two halves `layoutAround` returns, and JSX can't express half a document
- WHEN `full.ts` moves
- THEN `streamParts` stays, chapter fragments stay strings, and JSX builds only the pieces between them, since `renderToReadableStream` sent two async components as one chunk when measured
- AND the first chapter is still read before the 200, and a reader who leaves still cancels the stream, as `test/full-stream.node.test.ts` shows
- AND the shell around the chapters comes from the same layout as every other page, not a second copy of it

How to split the rendered layout around the chapters isn't settled: this case runs early because a poor answer here changes how the layout is written. `Suspense` wasn't tried, and anything it adds would have to pass the CSP.

#### Each page parses the same before and after
- GIVEN the moved assertions only show what they look at, and a dropped space or a lost attribute could pass them all
- WHEN a page module moves to JSX
- THEN its output on synthetic props, parsed and normalised to elements, attributes and collapsed text, matches a capture taken before any page moved
- AND a difference that is meant is an edit to the capture, with its reason in the PR
- AND the captures and their test are deleted with the last batch: they guard this migration, and no scenario case rests on them

#### Pages render with JSX, leaf first
- GIVEN a page module that interpolates a reader's or uploader's value
- WHEN it moves to JSX
- THEN `"><script>` in that value comes out as `&quot;&gt;&lt;script&gt;`, as `escapeHtml` gives it
- AND the moved tests pass with no assertion changed, and `npm run test:browser` passes, the layout and accessibility checks included
- AND a child moves before its parent, since a string of markup in a JSX parent comes out escaped
- AND a component's markup props are typed as JSX, not `string`, so passing one a string of markup fails `typecheck`
- AND once every batch has merged, `escapeHtml` is gone from `apps/web/src`
- AND one module owns unescaped HTML, exporting the doctype and the sanitized chapter fragment, and an idiom check finds `raw(` and `dangerouslySetInnerHTML` nowhere else
- AND the scripts and stylesheet served as strings (`*-script.ts`, `styles.ts`) stay as they are, since they aren't markup

The first batch settles how a JSX piece meets `layout`'s `body: string` while the layout is still a string, and the rest follow it. JSX drops a line break next to an element, so a word beside an inline element needs `{" "}`: the parsed capture above is what catches a missing one.

### Testing: what changes

#### Web tests use the shared helpers
- GIVEN `test/11-reader-and-csp.test.ts`, `test/15-search.test.ts` and `test/20-site-chrome.test.ts` keep their own `fetchW`, test files make a moderator with their own `.set({ role ... })`, and test files repeat `htmlOf` and `stylesheetOf`
- WHEN each moves as part of its parsed-HTML batch
- THEN no test file defines those, `signIn` in `test/helpers.ts` takes a role, and `set({ role` stays only in a test whose case is itself a change of role

Whether `Cloudflare.GlobalProps`'s `mainModule` can type `exports` in place of `exports as any` is unverified. The ticket tries it, and drops it if it fights the Vitest plugin.

#### Console capture has one helper per workspace
- GIVEN `consoleDuring` is in `test/helpers.ts`, which imports `cloudflare:workers`, so the `.node.test.ts` files that spy on the console can't use it, and `apps/mailer` has `captureLogs` twice
- WHEN they move to a helper in a file with no Workers import, one per workspace
- THEN `spyOn(console` appears in that one file per workspace

#### Waiting on something uses `vi.waitFor` or `expect.poll`
- GIVEN hand-written deadline loops in `test/helpers.ts`, `test/02-upload-confirm.test.ts`, `browser/harness/sessions.ts`, `site.ts` and `waitlist.ts`
- WHEN they are replaced
- THEN no test helper combines `for (;;)` with a `Date.now()` deadline
- AND a timeout still fails naming what it waited for, as `emailsTo` does: `vi.waitFor` defaults to one second, so each call states its own timeout
- AND a loop that isn't waiting, such as reading a stream or paging a listing, stays

Unverified: that `vi.waitFor` behaves in the workerd projects as in Node. The ticket tries one helper first and reports what it measures.

#### Browser suites find elements as a person does
- GIVEN `locator("h1")`, `locator("main")` and CSS selectors for labelled fields in `apps/web/browser`, and Playwright's docs recommending role and label locators over CSS
- WHEN they are moved
- THEN those use `getByRole` or `getByLabel`
- AND a locator with no user-facing handle, such as `li[data-upload-id=...]`, stays
- AND a test ID is the last resort, for an element with no such handle
- AND `npm run test:browser` passes, with the same number of tests

#### Known failures and focused tests
- GIVEN `it.fails("... (known failure: #405)")`, the form the browser journeys already use
- WHEN `npm test` and `npm run lint` run
- THEN an idiom check finds every `it.fails` title with `(known failure: #<n>)`, apart from the harness's test of its own failure handling
- AND `npm run lint` refuses `.only` and `.skip`, through `vitest/no-focused-tests` and `vitest/no-disabled-tests`, and leaves `skipIf` for an absent fixture alone

### Keeping it true

#### The rules enforce themselves
- GIVEN oxlint's `no-restricted-imports` and vitest rules can say some of these rules, and the rest need the syntax tree
- WHEN a rule above is broken
- THEN `npm run lint` or `npm test` fails, naming the file, the line and the rule
- AND an idiom check reads source with the `typescript` compiler API, not as text, so a comment or a string can't trip it
- AND an exception is an `oxlint-disable-next-line` with its reason, or a listed path with its reason in that check
- AND an item adds its check in the PR that makes it true, so no check holds a rule the code doesn't yet meet
- AND turning on oxlint's `vitest` plugin adds nothing else: when measured it also raised `expect-expect` warnings, which `--deny-warnings` would fail on

#### The rules are where agents read them
- WHEN the kept deviations are written down
- THEN `docs/ARCHITECTURE.md` lists each built-in not used, with its reason, and keeps its "Hono's JSX" line, which R1 makes true
- AND the item that settles a rule adds it where agents read it, then and not before: feature routers in `docs/ARCHITECTURE.md`, and in `/tdd` the `app.request` rule, parsed HTML for structure, `vi.waitFor` and `expect.poll` for waits, role-first locators, and the known-failure form

## Out of scope
- **Text-only assertions.** A `toContain` of a sentence already checks content, not spelling, and stays.
- **Renaming existing tests.** `/tdd` keeps existing names.
- **Real-time waits around the local rate limiter** (`windowHeadroom`). Its windows are aligned to the clock, and the waits exist for that reason.
- **Moving the browser suites to `@playwright/test`.** They run Playwright under Vitest by design (Q1b's harness).
- **`new Response` in handlers.** Some carry Better Auth's headers; there's no gain until one causes a problem.
- **`createMiddleware` in place of `MiddlewareHandler<E>`.** Both type the middleware, and Hono's own middleware returns `MiddlewareHandler`.
- **Route patterns in place of the ID parser.** `:id{[1-9][0-9]*}` also matches `/works/%31`, because Hono decodes the segment first. #211 and #235 own canonical IDs.
- **The mailer's `vi.spyOn(globalThis, "fetch")`.** `mocking.md` says senders are injected stubs, and the web Worker uses Miniflare's `outboundService`. A design change to the mailer, not an idiom swap.

## Work items

For `/to-tickets`, which sets each ticket's tier and blocking edges. What's recorded here is the order and why. Items in a row can run side by side.

| Step | Items | After |
|---|---|---|
| Now | Docs: the kept deviations. Lint rules already true. Tests for the kept boundaries. `onError`. Script route helper | None |
| Shared | #232, limited to `AppEnv` and `withDb`. #211, limited to the ID parser. The one same-origin guard | None; #211 after #232 |
| Routers | Prepare `src/index.ts`: group the route lines by router and mount empty routers, so each batch fills one router and removes one hunk. Then, side by side: admin home and queues (which needs no preparation); sign-in and terms; uploads; reader, work page, warnings, position, settings; listing and search; removal, DMCA, reports; wait list and site pages. Then narrow the ID parsers | The guard, #232, #211 |
| Tests | Parsed helper: choose the parser, add `signIn` with a role and `expectEscaped`, move one test file as the tracer. Then, side by side, by scenario: 01 to 03; 08 to 13; 14 to 17; 18; 20 to 23. `test/no-js-browser.ts` runs beside them if the parser is synchronous, and with the no-JS test files if not | Nothing in `src`, so beside the routers |
| JSX trial | Tooling tracer on a module with no routes. The entire-work trial. Parsed captures of each page | The tests that cover those pages |
| JSX pages | First batch, which settles the pattern. Then `settings` and small leaves such as `barSettings` and `review-notice`, which others use. Then, side by side: admin pages; listing, search, home; reader, work page, warnings; forms (DMCA, remove, report); uploads and wait list. Last, the layout and removing `escapeHtml` | The trial. Modules with no routes (`admin-pages`, `remove-pages`, `waitlist-pages`) can start beside the routers; a module with routes waits for its router batch |
| Any time | Console helpers. `vi.waitFor` and `expect.poll`. Browser locators | None |

Why this order:
- **Routers before JSX in the same module,** so no diff both moves a handler and rewrites its markup: a pure move is what the unchanged tests can vouch for.
- **Tests before JSX,** so they prove the migration rather than get rewritten during it.
- **The JSX trial early,** so a tooling or streaming problem surfaces before the batches depend on it.
- **Idiom checks in `apps/web/test`,** not `scripts/`, because `/gate` makes `scripts/` tier 3 and these items are otherwise tier 2. Only the one lint-rules PR changes root configuration.
- **Tiers.** Sign-in, uploads, the guard and the removal paths are on the security boundary. Other router batches, moved with few changed lines, may come in under `/gate`'s tier 2 limit, so split a batch rather than cross it.

## Measured

Run on the pinned versions outside the repo, type checks under the repo's `tsconfig` settings with a negative control. Docs are hono.dev, developers.cloudflare.com, vitest.dev and playwright.dev, read 2026-11-04.

| Claim | Result |
|---|---|
| `hono/csrf` against `isSameOrigin` | 11 header pairs across 5 content types: they disagree on 16 of 55, always with `csrf` allowing. It allows when either header passes, and doesn't check JSON |
| `csrf`'s refusal under today's `onError` | A 500 "Internal Server Error", because it throws `HTTPException`. Alone, it is a plain-text 403 |
| `secureHeaders` | Sets its CSP on JSON too, and adds `X-Frame-Options`, `Cross-Origin-Resource-Policy` and others the app doesn't send today. Its `Referrer-Policy: no-referrer` applies to every response, where the app sets its own per route (`strict-origin` on the token pages, for one) |
| `parseBody` behind `bodyLimit` | A streamed body over the limit gets a 413, as `readForm` refuses it, but a multipart body is read, where `readForm` never reads one |
| `app.on("POST", "*", guard)` ahead of the session | A refusal stopped at the guard, with no session step. `/admin` got the app's 404 and `/uploads` JSON. An exempt path passed through. A cross-site POST to an unknown URL got 403, and a same-site one 404. GET didn't reach the guard |
| `c.req.param("id")` type | `string` inline, in a sub-router and in `Context<E, "/works/:id">`. `string \| undefined` in a plain `Context<E>`, **and in `createHandlers`, which the docs offer as the typed form** |
| Feature routers | `c.notFound()` and a throw inside a router reach the parent's `notFound` and `onError`. `/login` from a router's `/` gives 200, and `/login/` gives 404. Two routers can share a base. HEAD works. A path in a `const` literal, like `SETTINGS_PATH`, keeps the parameter's type |
| A router's `use()` on a shared base | Runs on routers mounted after it: `/x/r` went through a gate that belonged to another router on `/x`. Mounted the other way round, it didn't |
| Hono JSX: escaping | Identical to `escapeHtml` on `a&b<c>d"e'f`, in text and in attributes. A `javascript:` URL passes through unchanged |
| Hono JSX: output | `<input .../>`, `<br/>`, and `defer=""` for a boolean attribute. `disabled={false}` is left out. `null`, `undefined`, `false` and `""` render nothing, and `0` renders `0`. A line break inside text becomes one space |
| Hono JSX: the doctype | Can't be written as JSX. Both ``html`<!doctype html>${...}` `` and `raw("<!doctype html>")` work, and `c.html` sends either as `text/html` |
| JSX mixed with strings | A JSX piece in a plain template gives its markup, with a cast for TypeScript. A string of markup in a JSX parent comes out escaped, and goes through with `raw` or `dangerouslySetInnerHTML` |
| `oxlint` 1.90 | `no-restricted-imports`, `vitest/no-focused-tests` and `vitest/no-disabled-tests` catch their cases, and leave a comment and `describe.skipIf` alone. The `vitest` plugin also raised `expect-expect` warnings |
| Markup assertions, `apps/web/test` | 224 lines assert on it (70 of them negative), 135 more extract from it, in 50 files. 51 lines name a void element. Counted by pattern, not read one by one, so these are sizes rather than exact totals |
