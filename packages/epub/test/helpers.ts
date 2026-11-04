import { expect } from "vitest";
import { EpubError, type EpubErrorCode } from "../src";

// Test helpers. The epub builders live in ./build, re-exported here.

export * from "./build";

export const MiB = 1024 * 1024;

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function expectEpubError(
  promise: Promise<unknown>,
  code: EpubErrorCode,
): Promise<void> {
  const err = await promise.then(
    () => null,
    // oxlint-disable-next-line deslop/no-unknown-parameters -- a rejection reason is unknown by contract
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EpubError);
  // SAFETY: the line above fails the test unless err is an EpubError.
  expect((err as EpubError).code).toBe(code);
}
