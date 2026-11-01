// A signed-in reader's choice to turn the warnings screen off: stored on the account
// (`user.warnings_off`), never in a cookie (ARCHITECTURE, Reading). The warnings screen
// and /settings/reader both write it here.

import { createDb } from "@archive/db";
import type { Bindings } from "./env";

/**
 * Sets `user.warnings_off` for `userId`. One query, so one connection. Best effort: a
 * failed write logs the kind of error only and never stops the page that asked, so
 * reading and saving the display settings go on; the screen shows again until it lands.
 */
export async function setWarningsOff(
  c: { env: Bindings; executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  userId: string,
  off: boolean,
) {
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    await db.updateTable("user").set({ warnings_off: off }).where("id", "=", userId).execute();
  } catch (error) {
    console.error(`Warnings off: ${error instanceof Error ? error.name : "unknown"}`);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
