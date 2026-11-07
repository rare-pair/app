import { inject, describe, expect, it } from "vitest";
import { bucketKeys, deliver, pendingUpload, uploadRow } from "./helpers";
import { ingestWorker } from "../src/worker";

const base64Bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

describe("12-pdf-upload", () => {
  describe("Hostile files", () => {
    it("A stream that inflates too far is refused", async () => {
      // The 261 KB file that inflates to 256 MB, from "What the tests showed".
      const bomb = base64Bytes(inject("inflateBombBase64"));
      expect(bomb.length).toBeLessThan(300_000);
      const id = await pendingUpload(bomb);
      let opened = 0;
      const handler = ingestWorker({
        loadPdfParser: async () => {
          opened++;
          throw new Error("the parser must not open this file");
        },
      });

      const result = await deliver([{ upload_id: id }], { handler });

      expect(opened).toBe(0);
      const row = await uploadRow(id);
      expect(row.status).toBe("zip_bomb");
      expect(row.error_stage).toBe("process");
      expect(result.explicitAcks).toEqual(["msg-0"]);
      expect(result.retryMessages).toEqual([]);
      expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    });
  });
});
