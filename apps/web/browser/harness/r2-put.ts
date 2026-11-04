import { presignPut } from "../../src/presign";
import { SITE } from "../../src/signin";
import { SECRETS } from "../../test/stand-ins";

// The browser's presigned PUT, standing in for R2's S3 endpoint: not R2. It's a Worker rather
// than a Playwright route because a route can't read a File's body (`postDataBuffer()` is null
// for `xhr.send(file)`). The web Worker never sees this request in production either, so it
// can't notice the swap. Like R2 it refuses a URL not signed for its key, content type and
// time, but R2's own signature check and the bucket's CORS rule are only shown by a deploy.

/** wrangler.jsonc's R2_BUCKET: a URL naming any other is signed wrongly. */
const R2_BUCKET = "rarepair";
/** The host the web Worker presigns for, under the throwaway account id. */
export const R2_HOST = `${SECRETS.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

/** X-Amz-Date's form, 20261104T043112Z, as a time. */
const amzDate = (value: string) =>
  new Date(value.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"));

/**
 * The key `url` was presigned for, signing again with `presignPut` and the throwaway keys, or
 * null when R2 would refuse it: forged, altered, late, or for another content type.
 */
export async function signedKey(
  url: string,
  contentType: string,
  now = new Date(),
): Promise<string | null> {
  const { pathname, searchParams } = new URL(url);
  const key = pathname.replace(`/${R2_BUCKET}/`, "");
  const signedAt = amzDate(searchParams.get("X-Amz-Date") ?? "");
  const expiresSeconds = Number(searchParams.get("X-Amz-Expires"));
  if (Number.isNaN(signedAt.getTime()) || !Number.isInteger(expiresSeconds)) return null;
  if (now.getTime() > signedAt.getTime() + expiresSeconds * 1000) return null;
  const expected = await presignPut({
    accountId: SECRETS.R2_ACCOUNT_ID,
    bucket: R2_BUCKET,
    accessKeyId: SECRETS.R2_ACCESS_KEY_ID,
    secretAccessKey: SECRETS.R2_SECRET_ACCESS_KEY,
    key,
    contentType,
    expiresSeconds,
    now: signedAt,
  });
  return expected === url ? key : null;
}

// Answers CORS as the site needs it, and stores a PUT that SIGNATURE (Node, below) signs off.
const R2_PUT_SCRIPT = /* js */ `
const cors = { "access-control-allow-origin": ${JSON.stringify(SITE)} };
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "PUT",
          "access-control-allow-headers": "content-type",
        },
      });
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: cors });
    const contentType = request.headers.get("content-type") ?? "";
    const signed = await env.SIGNATURE.fetch(request.url, {
      headers: { "content-type": contentType },
    });
    if (!signed.ok) return new Response("SignatureDoesNotMatch", { status: 403, headers: cors });
    await env.BUCKET.put(await signed.text(), request.body, { httpMetadata: { contentType } });
    return new Response(null, { status: 200, headers: cors });
  },
};
`;

/** The stand-in's Miniflare options, on the bucket every Worker shares. */
export const r2PutWorker = {
  name: "r2-put",
  modules: true,
  script: R2_PUT_SCRIPT,
  compatibilityDate: "2026-08-01",
  routes: [`${R2_HOST}/*`],
  r2Buckets: { BUCKET: { id: R2_BUCKET } },
  serviceBindings: {
    SIGNATURE: async (request: Request) => {
      const key = await signedKey(request.url, request.headers.get("content-type") ?? "");
      return key === null ? new Response(null, { status: 403 }) : new Response(key);
    },
  },
};
