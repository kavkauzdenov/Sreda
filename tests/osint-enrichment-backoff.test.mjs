/**
 * Enrichment queue backoff (§26.11, D5): упавший run уходит в
 * available_at-backoff — claimNext не выдаёт его до истечения окна,
 * иначе быстрое падение съедает лимит попыток в tight-loop между тиками.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Kysely, PGliteDialect, sql } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  claimNextEnrichment,
  runEnrichment,
} from "../src/server/intelligence/osint/enrichment.ts";
import { scenario } from "./helpers/osint-stage3-fixtures.mjs";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

test("failed enrichment run is claimed only after available_at backoff", async () => {
  const ctx = await scenario(db, "Backoff");

  // Ломаем первый шаг executeEnrichment — сбой до каких-либо записей,
  // чистый путь requeueOrFail.
  await sql`ALTER TABLE osint_observations RENAME TO osint_observations_hidden`.execute(db);
  let outcome;
  try {
    outcome = await runEnrichment(db, { businessId: ctx.business.id });
  } finally {
    await sql`ALTER TABLE osint_observations_hidden RENAME TO osint_observations`.execute(db);
  }
  assert.equal(outcome.status, "failed", outcome.error);
  assert.match(String(outcome.error), /osint_observations/);

  const row = await db
    .selectFrom("osint_enrichment_runs")
    .select(["id", "status", "attempts", "available_at"])
    .where("id", "=", outcome.runId)
    .executeTakeFirstOrThrow();
  assert.equal(row.status, "queued", "упавший run возвращён в очередь");
  assert.equal(Number(row.attempts), 1);
  assert.ok(
    row.available_at.getTime() > Date.now(),
    "backoff отодвигает следующую выдачу",
  );

  // До истечения backoff воркер не получает run.
  assert.equal(await claimNextEnrichment(db), null);

  // После истечения — получает.
  await db
    .updateTable("osint_enrichment_runs")
    .set({ available_at: new Date(Date.now() - 1000) })
    .where("id", "=", row.id)
    .execute();
  const claim = await claimNextEnrichment(db);
  assert.ok(claim, "после backoff run снова выдаётся");
  assert.equal(claim.id, row.id);
});
