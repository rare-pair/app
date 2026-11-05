import { AwsClient } from "aws4fetch";

// R2's Workers binding can't presign, so the URL is signed for R2's S3 endpoint
// with an R2 API token (ARCHITECTURE, Ingestion pipeline, step 1). No env and no
// clock of its own: the caller passes both.

/** What a presigned PUT is for, and who signs it. */
export type PresignPut = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The object key, made by the server: never from client input. */
  key: string;
  /** Signed, so R2 refuses a PUT that sends any other. */
  contentType: string;
  /**
   * The declared size in bytes, signed as `Content-Length`. Cloudflare's docs don't say whether
   * R2 refuses a PUT of another size, so `/complete` checks the stored size whatever R2 did.
   */
  contentLength: number;
  expiresSeconds: number;
  now: Date;
};

/** A query-signed (SigV4) URL that PUTs `key` into `bucket` until it expires. */
export async function presignPut(put: PresignPut): Promise<string> {
  // A secret never put arrives empty: fail rather than sign a URL that can't work.
  for (const field of ["accountId", "bucket", "accessKeyId", "secretAccessKey"] as const) {
    if (!put[field]) throw new Error(`R2 ${field} is not set`);
  }
  const client = new AwsClient({
    accessKeyId: put.accessKeyId,
    secretAccessKey: put.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = new URL(`https://${put.accountId}.r2.cloudflarestorage.com/${put.bucket}/${put.key}`);
  // aws4fetch keeps an X-Amz-Expires it finds, and signs a day without one.
  url.searchParams.set("X-Amz-Expires", String(put.expiresSeconds));
  const signed = await client.sign(
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": put.contentType, "Content-Length": String(put.contentLength) },
    }),
    {
      aws: {
        signQuery: true,
        // Without it aws4fetch leaves content-type and content-length out of the signature.
        allHeaders: true,
        datetime: put.now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
      },
    },
  );
  return signed.url;
}
