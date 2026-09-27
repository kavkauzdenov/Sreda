import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { migrate } from "../../src/server/db/migrate.ts";

// This suite exercises real Next production routes. It never uses an existing
// application database: a random disposable database is created on local PG.
test("production HTTPS account and workspace lifecycle", { timeout: 120000 }, async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, "Set TEST_DATABASE_URL to a local test PostgreSQL server");
  const source = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname), "Only local test PostgreSQL is allowed");
  assert.match(source.pathname, /test/i, "The source database must be explicitly named as a test database");
  const databaseName = "biznesoty_http_test_" + randomBytes(8).toString("hex");
  const admin = new Pool({ connectionString: source.href, max: 1 });
  let db; let child; let proxy; let certificateDir; let created = false;
  let origin; let ca; let backendPort;
  const secret = randomBytes(48).toString("base64url");
  const password = randomBytes(24).toString("base64url");
  let databaseUrl;

  async function stopApp() {
    if (!child || child.exitCode !== null) return;
    const current = child;
    const closed = once(current, "exit");
    current.kill("SIGTERM");
    const timer = setTimeout(() => current.kill("SIGKILL"), 5000);
    try { await closed; } finally { clearTimeout(timer); child = undefined; }
  }
  async function startApp() {
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(backendPort)], {
      env: { ...process.env, NODE_ENV: "production", NEXT_PUBLIC_DATA_SOURCE: "api", APP_URL: origin, DATABASE_URL: databaseUrl, BETTER_AUTH_SECRET: secret, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "ignore",
    });
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, "Next server exited before becoming ready");
      try { if ((await request("/login")).status === 200) return; } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("Next server did not become ready");
  }
  function request(path, { method = "GET", body, cookie = "", headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(origin + path, { method, ca, headers: {
        origin, cookie, "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}), ...headers,
      } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json; try { json = JSON.parse(text); } catch { /* HTML */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on("error", reject);
      req.setTimeout(10000, () => req.destroy(new Error("HTTP test request timed out")));
      req.end(data);
    });
  }
  async function account() {
    const username = "http_" + randomBytes(8).toString("hex");
    const result = await request("/api/auth/sign-up/username", { method: "POST", body: { username, password, passwordConfirmation: password } });
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.json, { ok: true });
    const cookies = result.headers["set-cookie"] ?? [];
    assert.ok(cookies.some((value) => /Secure/i.test(value) && /HttpOnly/i.test(value) && /SameSite=Lax/i.test(value)));
    const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const me = await request("/api/v1/me", { cookie });
    assert.equal(me.status, 200, me.text);
    assert.match(me.json.id, /^usr_[a-f0-9]{20}$/);
    return { username, cookie, user: me.json };
  }
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    source.pathname = "/" + databaseName;
    databaseUrl = source.href;
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 2 }) }) });
    await migrate(db, new URL("../../migrations", import.meta.url).pathname);
    await migrate(db, new URL("../../migrations", import.meta.url).pathname);
    certificateDir = await mkdtemp(join(tmpdir(), "biznesoty-http-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certificateDir, "key.pem"), "-out", join(certificateDir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    ca = await readFile(join(certificateDir, "cert.pem"));
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    backendPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    proxy = https.createServer({ key: await readFile(join(certificateDir, "key.pem")), cert: ca }, (req, res) => {
      const upstream = http.request({ hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-proto": "https", "x-forwarded-host": req.headers.host } }, (response) => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${proxy.address().port}`;
    await startApp();
    let owner; let invitee; let business; let invitation; let lead;
    await t.test("registration, secure sessions and newcomer page", async () => {
      assert.equal((await request("/api/v1/me")).status, 401);
      const mismatch = await request("/api/auth/sign-up/username", { method: "POST", body: { username: "mismatch", password, passwordConfirmation: "wrong" } });
      assert.equal(mismatch.status, 400);
      owner = await account(); invitee = await account();
      const page = await request("/business/new", { cookie: invitee.cookie });
      assert.equal(page.status, 200); assert.ok(page.text.includes(invitee.user.id));
      const dash = await request("/dashboard", { cookie: invitee.cookie });
      assert.equal(dash.status, 307); assert.equal(dash.headers.location, "/business/new");
    });
    await t.test("create workspace, invite and accept without owning a business", async () => {
      const result = await request("/api/v1/businesses", { method: "POST", cookie: owner.cookie, body: { name: "HTTP кофейня", timezone: "Europe/Kaliningrad" }, headers: { "idempotency-key": randomUUID() } });
      assert.equal(result.status, 201, result.text); business = result.json;
      const response = await request(`/api/v1/businesses/${business.id}/invitations`, { method: "POST", cookie: owner.cookie, body: { userId: invitee.user.id, role: "admin" } });
      assert.equal(response.status, 201, response.text); invitation = response.json;
      const incoming = await request("/api/v1/invitations", { cookie: invitee.cookie });
      assert.equal(incoming.status, 200); assert.equal(incoming.json[0].id, invitation.id);
      assert.equal((await request(`/api/v1/invitations/${invitation.id}/accept`, { method: "POST", cookie: invitee.cookie, body: {} })).status, 200);
      assert.equal((await request("/dashboard", { cookie: invitee.cookie })).status, 200);
      assert.equal((await request("/api/v1/businesses", { cookie: invitee.cookie })).json[0].role, "admin");
    });
    await t.test("permissions and DELETE route are enforced over HTTP", async () => {
      const base = `/api/v1/businesses/${business.id}`;
      assert.equal((await request(base + "/members", { method: "POST", cookie: invitee.cookie, body: { action: "revoke", userId: owner.user.id } })).status, 403);
      assert.equal((await request(base + "/members", { method: "POST", cookie: owner.cookie, headers: { origin: "https://evil.example" }, body: { action: "revoke", userId: invitee.user.id } })).status, 403);
      assert.equal((await request(base + "/members", { method: "POST", cookie: owner.cookie, body: { action: "change_role", userId: invitee.user.id, role: "operator" } })).status, 200);
      const visibleConnections = await request(base + "/connections", { cookie: invitee.cookie });
      assert.equal(visibleConnections.status, 200); assert.deepEqual(visibleConnections.json, []);
      assert.equal((await request(base + "/connections", { method: "POST", cookie: invitee.cookie, body: { platform: "telegram", token: "test-only-invalid-token" } })).status, 403);
      assert.equal((await request(base + "/connections?platform=telegram", { method: "DELETE", cookie: invitee.cookie })).status, 403);
      // Missing connection: 404 application error, not an unimplemented DELETE (405).
      const disconnected = await request(base + "/connections?platform=telegram", { method: "DELETE", cookie: owner.cookie });
      assert.equal(disconnected.status, 404); assert.equal(disconnected.json.error.code, "CONNECTION_NOT_FOUND");
      const activate = await request(base + "/solutions", {
        method: "POST",
        cookie: owner.cookie,
        body: { code: "leads", enabled: true },
      });
      assert.equal(activate.status, 200, activate.text);
      const createdLead = await request(base + "/leads", { method: "POST", cookie: invitee.cookie, body: { source: "telegram", name: "Тестовый клиент", externalEventId: "http-event" } });
      assert.equal(createdLead.status, 201, createdLead.text); lead = createdLead.json;
    });
    await t.test("lead page, filters and status update work over HTTPS", async () => {
      const base = `/api/v1/businesses/${business.id}/leads`;
      assert.equal((await request("/leads", { cookie: invitee.cookie })).status, 200);
      const denied = await request(`${base}/${lead.id}`, { method: "PATCH", cookie: invitee.cookie, headers: { origin: "https://evil.example" }, body: { status: "processing" } });
      assert.equal(denied.status, 403);
      const changed = await request(`${base}/${lead.id}`, { method: "PATCH", cookie: invitee.cookie, body: { status: "processing" } });
      assert.equal(changed.status, 200, changed.text); assert.equal(changed.json.status, "processing");
      assert.deepEqual((await request(base + "?status=new", { cookie: invitee.cookie })).json, []);
      assert.equal((await request(base + "?status=processing", { cookie: invitee.cookie })).json[0].id, lead.id);
      const cursor = encodeURIComponent(`${changed.json.createdAt}|${lead.id}`);
      assert.deepEqual((await request(base + "?before=" + cursor, { cookie: invitee.cookie })).json, []);
    });
    await t.test("solution setup persists through routes and Telegram remains disabled until deployment", async () => {
      const base = `/api/v1/businesses/${business.id}`;
      // Legacy V1 payload is accepted and converted to V2 on read/write.
      const draftV1 = { version: 1, step: 3, channels: ["telegram"], fields: ["name", "phone"] };
      const empty = await request(base + "/lead-setup", { cookie: owner.cookie });
      assert.equal(empty.status, 200); assert.equal(empty.json.revision, 0);
      const saved = await request(base + "/lead-setup", { method: "POST", cookie: owner.cookie, body: { draft: draftV1, revision: 0 } });
      assert.equal(saved.status, 200, saved.text); assert.equal(saved.json.revision, 1);
      const loaded = (await request(base + "/lead-setup", { cookie: owner.cookie })).json.draft;
      assert.equal(loaded.version, 2);
      assert.deepEqual(loaded.channels, ["telegram"]);
      assert.equal(loaded.setupStep, 6);
      assert.equal(loaded.completed, true);
      assert.equal(typeof loaded.buttonLabel, "string");
      assert.equal((await request(base + "/lead-setup", { method: "POST", cookie: owner.cookie, body: { draft: draftV1, revision: 0 } })).status, 409);
      assert.equal((await request(base + "/solutions", { cookie: owner.cookie })).json[0].status, "setup_required");
      assert.equal((await request(base + "/telegram/start", { method: "POST", cookie: owner.cookie, body: {} })).status, 503);
      assert.equal((await request("/api/telegram/00000000-0000-0000-0000-000000000000", { method: "POST", body: { update_id: 1 } })).status, 503);
      assert.equal((await request("/api/health")).status, 200);
    });
    await t.test("server restart retains accounts, sessions and business data", async () => {
      await stopApp(); await startApp();
      assert.equal((await request("/api/v1/me", { cookie: owner.cookie })).json.id, owner.user.id);
      const list = await request(`/api/v1/businesses/${business.id}/leads`, { cookie: invitee.cookie });
      assert.equal(list.status, 200); assert.equal(list.json[0].id, lead.id);
    });
    await t.test("revocation denies the next request and logout invalidates session", async () => {
      const base = `/api/v1/businesses/${business.id}`;
      assert.equal((await request(base + "/members", { method: "POST", cookie: owner.cookie, body: { action: "revoke", userId: invitee.user.id } })).status, 200);
      assert.equal((await request(base + "/leads", { cookie: invitee.cookie })).status, 404);
      assert.deepEqual((await request("/api/v1/businesses", { cookie: invitee.cookie })).json, []);
      assert.equal((await request(`/api/v1/invitations/${invitation.id}/accept`, { method: "POST", cookie: invitee.cookie, body: {} })).status, 404);
      assert.equal((await request("/api/auth/sign-out", { method: "POST", cookie: owner.cookie, body: {} })).status, 200);
      assert.equal((await request("/api/v1/me", { cookie: owner.cookie })).status, 401);
      const login = await request("/api/auth/sign-in/username", { method: "POST", body: { username: owner.username, password } });
      assert.equal(login.status, 200); assert.deepEqual(login.json, { ok: true });
    });
    await t.test("password change route retains this session and rejects old credentials", async () => {
      const user = await account();
      const login = await request("/api/auth/sign-in/username", { method: "POST", body: { username: user.username, password } });
      const otherCookie = login.headers["set-cookie"].map((v) => v.split(";")[0]).join("; ");
      const next = randomBytes(24).toString("base64url");
      const body = { currentPassword: password, newPassword: next, passwordConfirmation: next };
      assert.equal((await request("/api/v1/account/password", { method: "POST", body })).status, 401);
      const result = await request("/api/v1/account/password", { method: "POST", cookie: user.cookie, body });
      assert.equal(result.status, 200, result.text); assert.deepEqual(result.json, { ok: true });
      assert.equal((await request("/api/v1/me", { cookie: user.cookie })).status, 200);
      assert.equal((await request("/api/v1/me", { cookie: otherCookie })).status, 401);
      assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: { username: user.username, password } })).status, 400);
      assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: { username: user.username, password: next } })).status, 200);
    });
    await t.test("recovery routes issue codes and reset password without a session", async () => {
      const login = await request("/api/auth/sign-in/username", { method: "POST", body: { username: owner.username, password } });
      const cookie = login.headers["set-cookie"].map((value) => value.split(";")[0]).join("; ");
      const issued = await request("/api/v1/account/recovery-codes", { method: "POST", cookie, body: { currentPassword: password } });
      assert.equal(issued.status, 200, issued.text); assert.equal(issued.headers["cache-control"], "no-store");
      const code = issued.json.codes[0];
      assert.equal((await request("/recover")).status, 200);
      const next = randomBytes(24).toString("base64url");
      const reset = await request("/api/v1/account/recover", { method: "POST", body: { username: owner.username, recoveryCode: code, newPassword: next, passwordConfirmation: next } });
      assert.equal(reset.status, 200, reset.text);
      assert.equal((await request("/api/v1/me", { cookie })).status, 401);
      assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: { username: owner.username, password: next } })).status, 200);
    });
    await t.test("PIN routes gate login cookies, persist after restart, and reset through recovery", async () => {
      const user = await account();
      const body = { enabled: true, currentPassword: password, pin: "0826", pinConfirmation: "0826" };
      assert.equal((await request("/api/v1/account/pin")).status, 401);
      assert.equal((await request("/api/v1/account/pin", { method: "POST", cookie: user.cookie, headers: { origin: "https://evil.example" }, body })).status, 403);
      const saved = await request("/api/v1/account/pin", { method: "POST", cookie: user.cookie, body });
      assert.equal(saved.status, 200, saved.text); assert.deepEqual(saved.json, { enabled: true });
      assert.equal(saved.headers["cache-control"], "no-store");
      await stopApp(); await startApp();
      assert.deepEqual((await request("/api/v1/account/pin", { cookie: user.cookie })).json, { enabled: true });
      const loginBody = { username: user.username, password };
      for (const extra of [{}, { pin: "1111" }]) {
        const denied = await request("/api/auth/sign-in/username", { method: "POST", body: { ...loginBody, ...extra } });
        assert.equal(denied.status, 400); assert.equal(denied.json.error.code, "PIN_REQUIRED");
        assert.equal(denied.headers["set-cookie"], undefined);
      }
      const signedIn = await request("/api/auth/sign-in/username", { method: "POST", body: { ...loginBody, pin: "0826" } });
      assert.equal(signedIn.status, 200); assert.deepEqual(signedIn.json, { ok: true });
      assert.ok(signedIn.headers["set-cookie"].some(value => /Secure/i.test(value) && /HttpOnly/i.test(value)));
      const pinCookie = signedIn.headers["set-cookie"].map(value => value.split(";")[0]).join("; ");
      assert.equal((await request("/api/v1/me", { cookie: pinCookie })).status, 200);
      const changed = await request("/api/v1/account/pin", { method: "POST", cookie: user.cookie,
        body: { ...body, currentPin: "0826", pin: "6723", pinConfirmation: "6723" } });
      assert.equal(changed.status, 200); assert.equal((await request("/api/v1/me", { cookie: pinCookie })).status, 401);
      const issued = await request("/api/v1/account/recovery-codes", { method: "POST", cookie: user.cookie, body: { currentPassword: password } });
      assert.equal(issued.status, 200);
      const next = randomBytes(24).toString("base64url");
      const reset = await request("/api/v1/account/recover", { method: "POST", body: { username: user.username, recoveryCode: issued.json.codes[0], newPassword: next, passwordConfirmation: next } });
      assert.equal(reset.status, 200);
      assert.equal((await request("/api/v1/me", { cookie: user.cookie })).status, 401);
      const recovered = await request("/api/auth/sign-in/username", { method: "POST", body: { username: user.username, password: next } });
      assert.equal(recovered.status, 200);
      const restoredCookie = recovered.headers["set-cookie"].map(value => value.split(";")[0]).join("; ");
      assert.deepEqual((await request("/api/v1/account/pin", { cookie: restoredCookie })).json, { enabled: false });
    });
  } finally {
    await stopApp();
    if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
    if (db) await db.destroy();
    if (created) {
      // pg/Next shutdown may resolve before PostgreSQL has observed every socket
      // close. Do not forcibly terminate clients: that can emit a late unhandled
      // pool error after otherwise successful assertions.
      const deadline = Date.now() + 5000;
      while (true) {
        const remaining = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1", [databaseName]);
        if (remaining.rows[0].count === 0) break;
        assert.ok(Date.now() < deadline, "Test database still has connections after application shutdown");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await admin.query(`DROP DATABASE "${databaseName}"`);
    }
    await admin.end();
    if (certificateDir) await rm(certificateDir, { recursive: true, force: true });
  }
});
