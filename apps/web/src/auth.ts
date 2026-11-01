import { authSchema, type Database } from "@archive/db";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import type { Kysely } from "kysely";
import type { Bindings } from "./env";
import { LINK_LIFETIME_MINUTES, SITE } from "./signin";

/**
 * The session cookie's name: Better Auth's default, with the `__Secure-` prefix
 * `useSecureCookies` adds (ARCHITECTURE, Auth). Tests pin it against the real header.
 */
export const SESSION_COOKIE = "__Secure-better-auth.session_token";

/**
 * Better Auth, built per request: bindings only exist inside one, and a
 * per-request instance shares no in-process state with another isolate's
 * (ARCHITECTURE, Auth). Our routes call `auth.api.*`; `auth.handler`, with
 * Better Auth's own JSON endpoints, is not mounted.
 */
export function makeAuth(env: Bindings, db: Kysely<Database>) {
  return betterAuth({
    ...authSchema,
    // Our columns that the session lookup returns with the user, so a page needs no
    // query of its own. `input: false`: nothing a sign-in sends can set them.
    user: {
      ...authSchema.user,
      additionalFields: {
        // Null until the account accepts the terms on /welcome/terms (terms.ts).
        termsAcceptedAt: {
          type: "date",
          required: false,
          input: false,
          fieldName: "terms_accepted_at",
        },
        // True once the account turns the warnings screen off (warnings.ts, settings.ts).
        warningsOff: {
          type: "boolean",
          required: false,
          input: false,
          fieldName: "warnings_off",
        },
      },
    },
    // Fixed, never the request's host: sign-in links always go to rarepair.fans.
    baseURL: SITE,
    trustedOrigins: [SITE],
    secret: env.BETTER_AUTH_SECRET,
    database: { db, type: "postgres" },
    telemetry: { enabled: false },
    // Its logger prints a caught error whole, and one from Postgres can quote the row,
    // an address included. Our routes log what failed themselves: app.onError the
    // name of a thrown error, the confirm route the code of a sign-in that failed on our side.
    logger: { disabled: true },
    // Counters in Postgres, not in this isolate's memory. Only `auth.handler`
    // requests are counted, so `auth.api` calls from our routes never are. POST /login
    // has its own per-IP and per-email limits on the Workers rate-limiting binding
    // (A3, #23). POST /login/confirm and the session lookup have none yet (#242).
    rateLimit: { ...authSchema.rateLimit, enabled: true, storage: "database" },
    advanced: {
      // __Secure- cookies. No crossSubDomainCookies: no Domain, so never content.rarepair.fans.
      useSecureCookies: true,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    plugins: [
      magicLink({
        storeToken: "hashed",
        expiresIn: LINK_LIFETIME_MINUTES * 60,
        // Never logs its arguments: they hold the address and the link.
        sendMagicLink: async ({ email, token, metadata }) => {
          const link = new URL("/login/confirm", SITE);
          link.searchParams.set("token", token);
          // SAFETY: our route always passes metadata.next, a string from safeNext.
          link.searchParams.set("next", (metadata?.next as string | undefined) ?? "/");
          await env.EMAIL.send({ kind: "sign-in", to: email, url: link.href });
        },
      }),
    ],
  });
}
