// The removal request form, `/remove` (ARCHITECTURE, Author requests & takedowns): anyone
// can ask for a work or a pseud to be removed, signed in or not, behind Turnstile. This
// file takes the request in and stores it with a hashed network address. A request for a
// work hides the work at once (X2, #62), and one for a pseud opts it out and hides every work
// by it (X3, #63). One for a work the archive doesn't hold stores nothing and has its own
// page. Blocking a requester (X6, #67) belongs to the ticket after. The limits (X5, #64)
// are here: per IP before the body is read, per email once Turnstile has passed. Nothing
// here looks the requester up.

import { createDb, hideWork, normalizePseud } from "@archive/db";
import type { Context } from "hono";
// The mailer's own rule, so an address is accepted only if the mailer would send to it.
import { isSendableAddress } from "../../mailer/src/message";
import type { Bindings } from "./env";
import { ipHash } from "./ip-hash";
import { MAX_EMAIL, NO_STORE, readForm } from "./login";
import { emailKey, ipKey, isLimited, REMOVE_WINDOW_SECONDS, tooManyRequests } from "./rate-limit";
import { workId } from "./report";
import {
  MAX_PSEUD,
  MAX_STATEMENT,
  MAX_WORK,
  removePage,
  removeNotHeldPage,
  removeReceivedPage,
  type RemoveField,
  type RemoveForm,
} from "./remove-pages";
import type { SecurityVariables } from "./security";
import { SITE } from "./signin";
import { TURNSTILE_ACTIONS, verifyTurnstile } from "./turnstile";

type RemoveContext = Context<{ Bindings: Bindings; Variables: SecurityVariables }>;

// The form at its largest: a statement of 2000 characters percent-encodes to at most 18 KB,
// and a browser that counts characters differently can send several times that, so the cap
// leaves room: such a statement gets the 400 with what was typed, not a 413 that loses it.
const MAX_REMOVE_BODY = 64 * 1024;
/**
 * `GET /remove`: the form. It reads no session and no database, so it never shows whether
 * a work exists or is hidden. `?work=:id`, the AO3 work ID the work page links with,
 * prefills this site's URL for it; any other value is ignored.
 */
export function showRemoveForm(c: RemoveContext) {
  const id = workId(c.req.query("work"));
  const values = id === null ? {} : { work: `${SITE}/works/${id}` };
  return c.html(
    removePage(c.get("nonce"), c.env.TURNSTILE_SITE_KEY, c.env.MODERATORS_EMAIL, { values }),
  );
}

// A work's address on this site or at the original archive, with or without the scheme and
// "www.": the host and `/works/:id`, then nothing, or a path, query or fragment. The
// original archive's name is the one place it appears in code, as the address it has.
const WORK_ADDRESS = new RegExp(
  `^(?:https?://)?(?:www\\.)?(?:${new URL(SITE).host.replaceAll(".", "\\.")}|archiveofourown\\.org)/works/(\\d+)(?:[/?#].*)?$`,
  "i",
);

/** The AO3 work ID a work address names, or null when it names none. */
const workIdOf = (address: string) => workId(WORK_ADDRESS.exec(address)?.[1]);

/** A form value as typed: trimmed, and with the NUL a form is never sent and Postgres can't hold. */
const field = (form: URLSearchParams, name: RemoveField) =>
  (form.get(name) ?? "").replaceAll("\u0000", "").trim();

/**
 * Hides a work for a stored request, and links it to the request only when this hide changed
 * it: `hideWork` touches a live work only, so one hidden or removed already is left as it is
 * and gets no link. X6 (#67) conditions the hides of both branches, and the opt-out row, on
 * the requester not being blocked.
 */
async function hideForRequest(trx: Parameters<typeof hideWork>[0], requestId: string, id: string) {
  if (await hideWork(trx, id, "removal_request")) {
    await trx.insertInto("request_works").values({ request_id: requestId, work_id: id }).execute();
  }
}

/**
 * `POST /remove`, behind `sameOriginOnly` (index.ts): reads the body, checks Turnstile under
 * the form's own action, then the fields, and stores a pending request with the hashed
 * address. Every refusal shows the form again with what was typed and is sent `no-store`,
 * except a rate limit's 429, which is the shared plain page.
 * A work and a pseud together is a request for the work, since one request has one kind.
 * The reply to a stored request says nothing of what became of it.
 */
export async function submitRemove(c: RemoveContext) {
  const nonce = c.get("nonce");
  const siteKey = c.env.TURNSTILE_SITE_KEY;
  const page = (form: RemoveForm) => removePage(nonce, siteKey, c.env.MODERATORS_EMAIL, form);
  // Before the body is read, so a request over the limit costs neither a Turnstile check nor
  // a database write.
  const clientIp = c.req.header("cf-connecting-ip") ?? null;
  if (await isLimited(c.env.REMOVE_IP_LIMIT, await ipKey("remove", clientIp))) {
    return tooManyRequests(REMOVE_WINDOW_SECONDS);
  }
  const form = await readForm(c.req.raw, MAX_REMOVE_BODY);
  if (form === null) {
    // Nothing of it is shown back: the form comes again empty.
    const error = "That request was too large. Please try again.";
    return c.html(page({ error }), 413, NO_STORE);
  }

  // What was typed comes back, except an email too long to be an address.
  const email = field(form, "email");
  const typedWork = field(form, "work");
  const typedPseud = field(form, "pseud");
  const values = {
    email: email.length > MAX_EMAIL ? "" : email,
    work: typedWork.slice(0, MAX_WORK),
    pseud: typedPseud.slice(0, MAX_PSEUD),
    statement: (form.get("statement") ?? "").replaceAll("\r\n", "\n").replaceAll("\u0000", ""),
  };
  const turnstile = await verifyTurnstile(form.get("cf-turnstile-response"), {
    secret: c.env.TURNSTILE_SECRET_KEY,
    hostname: new URL(c.req.url).hostname,
    action: TURNSTILE_ACTIONS.remove,
    remoteIp: clientIp,
  });
  if (turnstile === "failed") {
    const error = "The anti-spam check did not pass. Please try again.";
    return c.html(page({ values, error }), 400, NO_STORE);
  }
  if (turnstile === "unavailable") {
    const error = "The anti-spam check is not answering just now. Please try again in a minute.";
    return c.html(page({ values, error }), 503, NO_STORE);
  }

  // The server checks, since a form can be posted by hand.
  const fieldErrors: Partial<Record<RemoveField, string>> = {};
  if (!isSendableAddress(email.toLowerCase()) || email.length > MAX_EMAIL) {
    fieldErrors.email = "Enter a valid email address, so a moderator can reply.";
  } else if (await isLimited(c.env.REMOVE_EMAIL_LIMIT, await emailKey("remove", email))) {
    // After Turnstile and a valid address, so only a solved check can spend an address's limit.
    return tooManyRequests(REMOVE_WINDOW_SECONDS);
  }
  const pseudTooLong = typedPseud.length > MAX_PSEUD;
  const pseudNorm = pseudTooLong ? "" : normalizePseud(typedPseud);
  const id = typedWork.length > MAX_WORK ? null : workIdOf(typedWork);
  // The pseud is only used when no work is given, so only then is it held to its limit.
  if (pseudTooLong && typedWork === "") {
    fieldErrors.pseud = `A pseud can be up to ${MAX_PSEUD} characters.`;
  } else if (typedWork === "" && pseudNorm === "") {
    fieldErrors.work = "Enter the web address of a work, or a pseud below.";
    fieldErrors.pseud = "Enter a pseud, or the web address of a work above.";
  }
  if (typedWork !== "" && id === null) {
    fieldErrors.work = "That is not the web address of a work, here or at the original archive.";
  }
  if (values.statement.length > MAX_STATEMENT) {
    fieldErrors.statement = `The statement can be up to ${MAX_STATEMENT} characters.`;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return c.html(page({ values, fieldErrors }), 400, NO_STORE);
  }

  const ip_hash = await ipHash(c.env.IP_HASH_KEY, clientIp);
  // Its queries run one after another, so one connection.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    const base = { contact_email: email, statement: values.statement, ip_hash };
    if (typedWork !== "") {
      const work =
        id === null
          ? undefined
          : await db
              .selectFrom("works")
              .select("id")
              .where("ao3_work_id", "=", id)
              .executeTakeFirst();
      // A work the archive doesn't hold stores nothing and gets its own page.
      if (work === undefined) return c.html(removeNotHeldPage(), 200, NO_STORE);
      // A work of any status is stored, so a request for one already hidden or removed is
      // not lost, and its answer is the same. The request, the hide and the link commit
      // together, or a reversal would miss a work.
      await db.transaction().execute(async (trx) => {
        const request = await trx
          .insertInto("requests")
          .values({ ...base, kind: "remove_work", work_id: work.id })
          .returning("id")
          .executeTakeFirstOrThrow();
        await hideForRequest(trx, request.id, work.id);
      });
    } else {
      // The request, the opt-out row and every hide commit together, so a reversal sees
      // each work this request hid.
      await db.transaction().execute(async (trx) => {
        const request = await trx
          .insertInto("requests")
          .values({ ...base, kind: "opt_out", pseud_norm: pseudNorm })
          .returning("id")
          .executeTakeFirstOrThrow();
        // X6 (#67) conditions this block, the active row and the hides, on the requester not
        // being blocked.
        await trx
          .insertInto("optouts")
          .values({ pseud_norm: pseudNorm, request_id: request.id, active: true })
          .execute();
        // A stored pseud is as written, so it is matched here by the rule the opt-out list
        // uses, not in SQL. This reads every author row: it grows with the archive.
        const authors = await trx.selectFrom("work_authors").select(["work_id", "pseud"]).execute();
        const matching = new Set<string>();
        for (const author of authors) {
          if (normalizePseud(author.pseud) === pseudNorm) matching.add(author.work_id);
        }
        // In id order, so two overlapping requests lock the same works in the same order.
        for (const matched of [...matching].sort()) await hideForRequest(trx, request.id, matched);
      });
    }
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
  return c.html(removeReceivedPage(), 200, NO_STORE);
}
