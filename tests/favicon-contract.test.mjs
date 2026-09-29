import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("favicon is exposed through stable and cache-busted browser paths", () => {
  const layout = read("src/app/layout.tsx");
  const route = read("src/app/favicon.ico/route.ts");
  const appIcon = read("src/app/icon.svg");
  const brandIcon = read("public/assets/soty/brand/favicon.svg");

  assert.match(layout, /\/favicon\.ico\?v=4/);
  assert.match(layout, /favicon\.svg\?v=4/);
  assert.match(route, /\/assets\/soty\/brand\/favicon\.svg\?v=4/);
  assert.match(route, /Cache-Control/);
  assert.equal(appIcon, brandIcon);
});
