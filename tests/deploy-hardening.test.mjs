import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("production compose keeps background jobs independent from Telegram", () => {
  const compose = read("deploy/compose.yml");
  assert.match(compose, /background-worker:/);
  assert.match(compose, /scripts\/background-worker\.mts/);
  assert.match(compose, /telegram-worker:/);
  assert.match(compose, /scripts\/telegram-worker\.mts/);
  assert.match(compose, /meta-worker:/);
  const backgroundBlock = compose
    .split("  background-worker:", 2)[1]
    ?.split("\n  telegram-worker:", 1)[0] ?? "";
  assert.notEqual(backgroundBlock, "");
  assert.equal(/profiles:/.test(backgroundBlock), false);
});

test("database health and backup use runtime DB identity instead of brand names", () => {
  const compose = read("deploy/compose.yml");
  const backup = read("deploy/backup.sh");
  assert.match(compose, /\$\$POSTGRES_USER/);
  assert.match(compose, /\$\$POSTGRES_DB/);
  assert.match(backup, /POSTGRES_USER/);
  assert.match(backup, /POSTGRES_DB/);
  assert.equal(/pg_dump -U biznesoty -d biznesoty/.test(backup), false);
});

test("release is immutable and backs up before migrations", () => {
  const release = read("deploy/release.sh");
  assert.match(release, /sreda:\[a-f0-9\]\{40\}/);
  assert.equal(/biznesoty:latest/.test(release), false);
  const backupAt = release.indexOf("backup.sh");
  const migrateAt = release.indexOf("run --rm migrate");
  assert.ok(backupAt >= 0);
  assert.ok(migrateAt > backupAt);
  assert.match(release, /LAST_GOOD_IMAGE/);
  assert.match(release, /migration_before/);
  assert.match(release, /migration_after/);
});

test("controlled deployment does not require Yandex Registry credentials", () => {
  const workflow = read(".github/workflows/deploy-yandex.yml");
  const release = read("deploy/release.sh");
  assert.match(workflow, /IMAGE: biznesoty:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /docker save "\$IMAGE"/);
  assert.match(workflow, /sha256sum -c biznesoty-image\.tar\.gz\.sha256/);
  assert.match(workflow, /docker load/);
  assert.equal(/YC_REGISTRY_KEY/.test(workflow), false);
  assert.equal(/docker\/login-action/.test(workflow), false);
  assert.match(release, /image_source="local"/);
  assert.match(release, /docker image inspect "\$image"/);
});

test("production image exposes immutable build metadata", () => {
  const dockerfile = read("Dockerfile");
  const workflow = read(".github/workflows/deploy-yandex.yml");
  const version = read("src/app/api/version/route.ts");
  assert.match(dockerfile, /APP_BUILD_SHA/);
  assert.match(workflow, /BUILD_SHA="\$GITHUB_SHA"/);
  assert.match(version, /APP_BUILD_SHA/);
  assert.match(version, /APP_BUILD_TIME/);
});

test("restore drill never targets production database", () => {
  const drill = read("deploy/restore-drill.sh");
  assert.match(drill, /docker run -d --rm/);
  assert.match(drill, /restore_test/);
  assert.match(drill, /pg_restore/);
  assert.equal(/deploy-db-1/.test(drill), false);
});
