import { createTestDb } from "@archive/db/testing";
import type { TestProject } from "vitest/node";

// workerd can't run PGlite, so the test database starts here in Node, migrated, and the
// Worker reaches it through its Hyperdrive binding. One database serves every test: each seeds
// its own works, and the sweep's one state row is reset before each test.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // The setup's own client, plus each run's connection and the tests' own; a finished run's
  // connection can still be closing.
  const t = await createTestDb({ maxConnections: 16 });
  project.provide("databaseUrl", t.connectionString);
  return () => t.close();
}
