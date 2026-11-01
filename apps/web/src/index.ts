import { Hono } from "hono";
import { except } from "hono/combine";
import { admin } from "./admin";
import { assetRoute } from "./assets";
import { confirmSignIn, showConfirm } from "./confirm";
import type { Bindings } from "./env";
import { showFull } from "./full";
import { deadLetteredLaunchEmails } from "./launch-dead-letter";
import { showTagListing } from "./listing";
import { requestSignIn, showSignIn } from "./login";
import { jumpToChapter, showChapter } from "./reader";
import { sameOriginOnly, showReportForm, submitReport } from "./report";
import { aboutPage, notFoundPage, privacyPage, termsPage } from "./pages";
import { showRemoveForm, submitRemove } from "./remove";
import { pageState } from "./page-state";
import { SETTINGS_SCRIPT, SETTINGS_SCRIPT_PATH } from "./reader-settings";
import { closedBeforeLaunch, disableClosedLinks, isPrelaunch } from "./prelaunch";
import {
  contentSecurityPolicy,
  strictTransportSecurity,
  wwwToBareDomain,
  type SecurityVariables,
} from "./security";
import { requireSignIn, sessionMiddleware, type SessionVariables } from "./session";
import { saveSettings, SETTINGS_PATH, showSettings } from "./settings";
import { STYLESHEET, STYLESHEET_PATH } from "./styles";
import { acceptTerms, showTerms, termsGate, WELCOME_TERMS } from "./terms";
import { requestUpload, sameOriginUpload, showUpload } from "./upload";
import { joinWaitlist } from "./waitlist";
import { confirmWaitlist, showWaitlistConfirm } from "./waitlist-confirm";
import { comingSoonPage } from "./waitlist-pages";
import { showWaitlistUnsubscribe, unsubscribeWaitlist } from "./waitlist-unsubscribe";
import { showWork } from "./work-page";

const app = new Hono<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>();

// Order matters: HSTS covers everything, the www redirect included, and www
// never reaches the CSP, the routes or anything that could set a cookie. Before
// launch, closed pages are redirected next, so they carry HSTS but never a page.
app.use(strictTransportSecurity);
app.use(wwwToBareDomain);
app.use(closedBeforeLaunch);
app.use(contentSecurityPolicy);
// Before the session, so a cross-site upload or report is refused without a lookup.
app.post("/uploads", sameOriginUpload);
app.post("/works/:id/report", sameOriginOnly);
app.post("/remove", sameOriginOnly);
// The session, once, for every page; routes read c.var.session and never mount it
// again. Static files skip it, and the lookup's database connection with it. Then
// an account that hasn't accepted the terms is sent to accept them.
app.use(except("/assets/*", sessionMiddleware, termsGate));
// The reader's settings, on every page. Inside the CSP, which keys on what it returns,
// and after the terms gate, never in front of it.
app.use(pageState);
// Before launch, links to closed pages are shown disabled.
app.use(disableClosedLinks);

// The moderation area: every /admin URL goes through its gate (admin.ts).
app.route("/admin", admin);

// The wait list pages' fonts and stylesheet. S1 serves its own stylesheet elsewhere under /assets/.
app.get("/assets/waitlist/*", assetRoute);

// The coming-soon page before launch. After it there is no home page yet.
app.get("/", (c) =>
  isPrelaunch(c.env)
    ? c.html(comingSoonPage(c.get("nonce"), c.env.TURNSTILE_SITE_KEY))
    : c.notFound(),
);
app.get("/login", showSignIn);
app.post("/login", requestSignIn);
app.get("/login/confirm", showConfirm);
app.post("/login/confirm", confirmSignIn);
app.get(WELCOME_TERMS, requireSignIn, showTerms);
app.post(WELCOME_TERMS, acceptTerms);
app.post("/waitlist", joinWaitlist);
app.get("/waitlist/confirm", showWaitlistConfirm);
app.post("/waitlist/confirm", confirmWaitlist);
app.get("/waitlist/unsubscribe", showWaitlistUnsubscribe);
app.post("/waitlist/unsubscribe", unsubscribeWaitlist);
// After launch, a stale link to the form goes home. Before it, nothing is at GET /waitlist.
app.get("/waitlist", (c) => (isPrelaunch(c.env) ? c.notFound() : c.redirect("/", 302)));
app.get("/upload", showUpload);
app.post("/uploads", requestUpload);
app.get("/remove", showRemoveForm);
app.post("/remove", submitRemove);

// The reader. Closed before launch, like every /works/ page.
app.get("/works/:id/chapters/:n", showChapter);
app.get("/works/:id/chapters", jumpToChapter);
app.get("/works/:id/full", showFull);

// Reader settings, signed in or not. Closed before launch, like the reader.
app.get(SETTINGS_PATH, showSettings);
app.post(SETTINGS_PATH, saveSettings);

app.get("/about", (c) => c.html(aboutPage()));
app.get("/terms", (c) => c.html(termsPage()));
app.get("/privacy", (c) => c.html(privacyPage()));

app.get("/works/:id", showWork);
// Signed in only.
app.get("/works/:id/report", showReportForm);
app.post("/works/:id/report", submitReport);
app.get("/tags/:type/:name", showTagListing);

// The URL carries a hash of the content, so the response never changes under it.
app.get(STYLESHEET_PATH, (c) =>
  c.body(STYLESHEET, 200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  }),
);

// The reader settings script, likewise hashed. Loaded with the page's nonce.
app.get(SETTINGS_SCRIPT_PATH, (c) =>
  c.body(SETTINGS_SCRIPT, 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  }),
);

// no-store on every 404, as on the /admin pages: the admin gate refuses with
// this answer, and a header only its refusal sent would point at /admin.
app.notFound((c) => {
  c.header("Cache-Control", "no-store");
  return c.html(notFoundPage(), 404);
});
// Hono's default logs the whole error, and one from Postgres can quote the row it
// failed on, a sign-in address included. Log only what kind of error it was.
app.onError((error, c) => {
  // The path is decoded, so a control, format or line-separator character in it
  // could start a forged line or reorder what a log viewer shows.
  const path = c.req.path.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?");
  console.error(`${c.req.method} ${path}: ${error.name}`);
  return c.text("Internal Server Error", 500);
});

// Hono's `fetch` is bound to the app, so it can sit in this object. `queue` takes the
// email-bulk-dlq batches (wrangler.jsonc consumers).
export default {
  fetch: app.fetch,
  queue: deadLetteredLaunchEmails,
} satisfies ExportedHandler<Bindings>;
