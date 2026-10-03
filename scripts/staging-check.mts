import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { stagingConfiguration } from "../src/server/readiness/config.ts";
const checks = stagingConfiguration(process.env);
for (const c of checks)
  console.log(`${c.ok ? "OK" : "MISSING"} ${c.name}: ${c.message}`);
let ok = checks.every((c) => c.ok);
if (
  process.argv.includes("--database") &&
  checks.find((c) => c.name === "DATABASE_URL")?.ok
) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  try {
    // Read-only: never migrate, create fixture data or activate a webhook.
    const applied = (
      await pool.query("select name,checksum from sreda_migration")
    ).rows;
    const directory = new URL("../migrations/", import.meta.url);
    const files = (await readdir(directory))
      .filter((n) => /^\d+_[\w-]+\.sql$/.test(n))
      .sort();
    for (const name of files) {
      const checksum = createHash("sha256")
        .update(await readFile(new URL(name, directory)))
        .digest("hex");
      const found = applied.find((r) => r.name === name);
      const valid = found?.checksum === checksum;
      console.log(
        `${valid ? "OK" : "BLOCKED"} migration ${name}: ${!found ? "not applied" : valid ? "verified" : "checksum mismatch; do not overwrite migration history"}`,
      );
      ok &&= valid;
    }
    const beats = (
      await pool.query("select name,seen_at from worker_heartbeat")
    ).rows;
    for (const name of [
      "background",
      "osint",
      "telegram",
      "vk",
      "autopost",
      "booking_reminders",
    ]) {
      const valid = beats.some(
        (b) => b.name === name && +new Date(b.seen_at) > Date.now() - 60000,
      );
      console.log(
        `${valid ? "OK" : "BLOCKED"} worker ${name}: ${valid ? "recent heartbeat" : "missing or stale"}`,
      );
      ok &&= valid;
    }
  } catch {
    console.error(
      "BLOCKED DATABASE: connection/schema inspection failed; check staging config and migration status.",
    );
    ok = false;
  } finally {
    await pool.end();
  }
}
console.log(
  "Credentials are not printed. Provider access, webhook delivery and S3/AI operations still require the manual E2E checklist.",
);
process.exitCode = ok ? 0 : 1;
