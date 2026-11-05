import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { presignPut, type PresignPut } from "../src/presign";

// R2 itself refuses a PUT with another Content-Type, or after the URL expires; Miniflare's R2
// has no S3 endpoint, so no test here can PUT. What R2 checks is the signature, so these
// tests show the URL signs what R2 will check: the content type, the size and a 600 s expiry.
// Whether R2 enforces a signed Content-Length is unknown (ARCHITECTURE, Orphaned uploads), so
// these show only that it is signed.
// The expected signature is worked out here, from AWS's published SigV4 query-signing steps
// (canonical request, string to sign, derived key), not by aws4fetch.

// Throwaway test values, not credentials.
const PUT: PresignPut = {
  accountId: "test0000000000000000000000000acct",
  bucket: "rarepair",
  accessKeyId: "test-only-access-key-id",
  secretAccessKey: "test-only-secret-access-key",
  key: "uploads/00000000-0000-4000-8000-000000000001",
  contentType: "application/epub+zip",
  contentLength: 123456,
  expiresSeconds: 600,
  now: new Date("2026-10-31T12:34:56.789Z"),
};
const HOST = "test0000000000000000000000000acct.r2.cloudflarestorage.com";
const DATETIME = "20261031T123456Z";
const SCOPE = "20261031/auto/s3/aws4_request";

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
// RFC 3986: every byte but the unreserved ones is percent-encoded.
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The signature AWS's SigV4 steps give a query-signed PUT of `key` with `contentType`. */
function expectedSignature(key: string, contentType: string, expires = "600", length = "123456") {
  const query: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${PUT.accessKeyId}/${SCOPE}`],
    ["X-Amz-Date", DATETIME],
    ["X-Amz-Expires", expires],
    ["X-Amz-SignedHeaders", "content-length;content-type;host"],
  ];
  const canonicalRequest = [
    "PUT",
    `/rarepair/${key.split("/").map(encode).join("/")}`,
    query.map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&"),
    `content-length:${length}\ncontent-type:${contentType}\nhost:${HOST}\n`,
    "content-length;content-type;host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", DATETIME, SCOPE, sha256(canonicalRequest)].join("\n");
  let signingKey = hmac(`AWS4${PUT.secretAccessKey}`, "20261031");
  for (const part of ["auto", "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

describe("02-upload-handshake", () => {
  it("Upload request returns a presigned PUT URL", async () => {
    const url = new URL(await presignPut(PUT));
    expect(url.origin).toBe(`https://${HOST}`);
    expect(url.pathname).toBe("/rarepair/uploads/00000000-0000-4000-8000-000000000001");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
    ]);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(`test-only-access-key-id/${SCOPE}`);
    expect(url.searchParams.get("X-Amz-Date")).toBe(DATETIME);
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      expectedSignature(PUT.key, "application/epub+zip"),
    );
    // Only the S3 endpoint carries the credentials: no secret in the URL.
    expect(url.toString()).not.toContain(PUT.secretAccessKey);
  });

  it("Presigned PUT with the wrong content type fails", async () => {
    const url = new URL(await presignPut(PUT));
    // R2 recomputes the signature over the Content-Type the PUT sends.
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    const signature = url.searchParams.get("X-Amz-Signature");
    expect(signature).toBe(expectedSignature(PUT.key, "application/epub+zip"));
    for (const other of ["application/octet-stream", "text/html", "application/zip"]) {
      expect(signature).not.toBe(expectedSignature(PUT.key, other));
    }
  });

  it("Presigned PUT after 10 minutes fails", async () => {
    const url = new URL(await presignPut(PUT));
    // R2 refuses the URL once X-Amz-Date plus X-Amz-Expires seconds have passed.
    expect(url.searchParams.get("X-Amz-Date")).toBe(DATETIME);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    // And the expiry is signed: a URL edited to last longer no longer matches.
    const signature = url.searchParams.get("X-Amz-Signature");
    expect(signature).toBe(expectedSignature(PUT.key, "application/epub+zip", "600"));
    expect(signature).not.toBe(expectedSignature(PUT.key, "application/epub+zip", "86400"));
  });

  it("Each link is signed for the size declared when it was asked for", async () => {
    const url = new URL(await presignPut({ ...PUT, contentLength: 2048 }));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    const signature = url.searchParams.get("X-Amz-Signature");
    expect(signature).toBe(expectedSignature(PUT.key, "application/epub+zip", "600", "2048"));
    expect(signature).not.toBe(expectedSignature(PUT.key, "application/epub+zip", "600", "2049"));
  });

  it("An unset R2 secret signs nothing", async () => {
    // A secret never put arrives empty: no URL naming "undefined" or "" is handed out.
    for (const field of ["accountId", "bucket", "accessKeyId", "secretAccessKey"] as const) {
      const put = { ...PUT, [field]: "" };
      await expect(presignPut(put), field).rejects.toThrow(`R2 ${field} is not set`);
    }
  });

  it("Each key gets its own signature", async () => {
    const other = { ...PUT, key: "uploads/00000000-0000-4000-8000-000000000002" };
    const url = new URL(await presignPut(other));
    expect(url.pathname).toBe("/rarepair/uploads/00000000-0000-4000-8000-000000000002");
    const signature = url.searchParams.get("X-Amz-Signature");
    expect(signature).toBe(expectedSignature(other.key, "application/epub+zip"));
    expect(signature).not.toBe(expectedSignature(PUT.key, "application/epub+zip"));
  });
});
