import { createTestDb } from "@archive/db/testing";
import type { TestProject } from "vitest/node";

// workerd can't run PGlite, so the test database starts here in Node, migrated, and the
// Worker reaches it through its Hyperdrive binding. One database serves every test file, and
// the files run in parallel: each keeps to its own AO3 work ids (42900-42999, 8812600-8812699),
// which is the only isolation between them.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // The setup's own client, plus each run's connection and the tests' own; a finished run's
  // connection can still be closing.
  const t = await createTestDb({ maxConnections: 16 });
  project.provide("databaseUrl", t.connectionString);
  return () => t.close();
}
