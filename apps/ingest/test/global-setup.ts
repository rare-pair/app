import { createTestDb } from "@archive/db/testing";
import { deflateSync } from "node:zlib";
import type { TestProject } from "vitest/node";

/** The hostile file from spec 12: one page, one content stream, 256 MB of spaces deflated. */
function inflateBombPdf(): Buffer {
  const data = deflateSync(Buffer.alloc(256 * 1024 * 1024, 0x20), { level: 9 });
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  const push = (object: Buffer) => {
    offsets.push(at);
    parts.push(object);
    at += object.length;
  };
  objects.forEach((body, i) => push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`)));
  push(
    Buffer.concat([
      Buffer.from(`4 0 obj\n<< /Filter /FlateDecode /Length ${data.length} >>\nstream\n`),
      data,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
  );
  const table = ["xref", "0 5", "0000000000 65535 f "];
  for (const offset of offsets) table.push(`${String(offset).padStart(10, "0")} 00000 n `);
  parts.push(
    Buffer.from(
      `${table.join("\n")}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

// workerd can't run PGlite, so the test database starts here in Node, migrated, and the
// Worker reaches it through its Hyperdrive binding. One database serves every test file:
// each test makes its own user and uploads rather than resetting it.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // The setup's own client, plus room for each queue invocation's pool and the tests' own,
  // in every file running at once. The most one test opens together is the flood case's
  // five uploads; a finished invocation's pool can still be closing (ctx.waitUntil).
  const t = await createTestDb({ maxConnections: 64 });
  project.provide("databaseUrl", t.connectionString);
  project.provide("inflateBombBase64", inflateBombPdf().toString("base64"));
  return () => t.close();
}
