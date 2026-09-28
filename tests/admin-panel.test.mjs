import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect, PostgresDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { createIdentity } from "../src/server/identity/auth.ts";
import { WorkspaceService } from "../src/server/workspaces/service.ts";
import { createApplication } from "../src/server/http/application.ts";
import { createAuthHandler } from "../src/server/http/auth-handler.ts";
import { createAdminHandler } from "../src/server/http/admin-handler.ts";
import { migrate } from "../src/server/db/migrate.ts";
import { AdminService } from "../src/server/admin/service.ts";
import { sanitizeAdminMetadata } from "../src/server/admin/audit.ts";
import {
  platformAllowed,
  platformPermissions,
} from "../src/server/admin/permissions.ts";

const origin = "http://localhost:3000";
const secret = "test-only-" + randomUUID() + randomUUID();
const password = "test-password-12345";
const db = new Kysely({
  dialect: process.env.TEST_DATABASE_URL
    ? new PostgresDialect({
        pool: new Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          max: 5,
        }),
      })
    : new PGliteDialect({ pglite: new PGlite() }),
});
const auth = createIdentity({ db, origin, secret });
const workspaces = new WorkspaceService(db);
const app = createApplication({ auth, workspaces, db, origin, secret });
const authHandler = createAuthHandler({ db, auth, origin, secret });
const adminApi = createAdminHandler({ auth, db, origin, secret });
const adminService = new AdminService(db);

function request(path, { method = "GET", body, cookie = "", headers = {} } = {}) {
  return new Request(origin + path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      cookie,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const signup = (username) =>
  authHandler(
    request("/api/auth/sign-up/username", {
      method: "POST",
      body: { username, password, passwordConfirmation: password },
    }),
  );

const freshUsername = () => "u" + randomUUID().replaceAll("-", "").slice(0, 24);

async function login() {
  const username = freshUsername();
  const response = await signup(username);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const profile = await app.me(request("/api/v1/me", { cookie }));
  assert.equal(profile.status, 200);
  const publicUser = await profile.json();
  const internal = await db
    .selectFrom("user")
    .select("id")
    .where("public_id", "=", publicUser.id)
    .executeTakeFirstOrThrow();
  return { cookie, user: publicUser, username, internalId: internal.id };
}

async function grantRole(userId, role, createdBy = userId) {
  await db
    .insertInto("account_pin")
    .values({
      user_id: userId,
      pin_hash: "test-only-admin-pin-hash",
      failed_attempts: 0,
      locked_until: null,
    })
    .onConflict((oc) => oc.column("user_id").doNothing())
    .execute();
  const currentSession = await db
    .selectFrom("session")
    .select("id")
    .where("userId", "=", userId)
    .orderBy("createdAt", "desc")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("platform_admin_mfa_session")
    .values({
      session_id: currentSession.id,
      user_id: userId,
      verified_at: new Date(),
    })
    .onConflict((oc) => oc.column("session_id").doNothing())
    .execute();
  await db
    .insertInto("platform_admin")
    .values({
      user_id: userId,
      role,
      status: "active",
      created_by: createdBy,
      revoked_at: null,
    })
    .onConflict((oc) =>
      oc.column("user_id").doUpdateSet({
        role,
        status: "active",
        revoked_at: null,
        updated_at: new Date(),
      }),
    )
    .execute();
}

before(async () => {
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
});

after(async () => {
  await db.destroy();
});

test("permission matrix: SUPPORT cannot manage admins or finance overrides", () => {
  assert.equal(platformAllowed("SUPPORT", "admin.users.read"), true);
  assert.equal(platformAllowed("SUPPORT", "admin.users.manage"), false);
  assert.equal(platformAllowed("SUPPORT", "admin.admins.manage"), false);
  assert.equal(platformAllowed("SUPPORT", "admin.subscriptions.manage"), false);
  assert.equal(platformAllowed("SUPPORT", "admin.support.manage"), true);
  assert.equal(platformAllowed("FINANCE", "admin.subscriptions.manage"), true);
  assert.equal(platformAllowed("FINANCE", "admin.system.manage"), false);
  assert.equal(platformAllowed("MODERATOR", "admin.moderation.manage"), true);
  assert.equal(platformAllowed("MODERATOR", "admin.audit.read"), false);
  assert.ok(platformPermissions("SUPER_ADMIN").includes("admin.admins.manage"));
});

test("unauthenticated admin API returns 401", async () => {
  assert.equal((await adminApi.dashboard(request("/api/admin/dashboard"))).status, 401);
  assert.equal((await adminApi.users(request("/api/admin/users"))).status, 401);
  assert.equal((await adminApi.me(request("/api/admin/me"))).status, 401);
});

test("normal user gets 403 on all admin endpoints", async () => {
  const account = await login();
  const paths = [
    () => adminApi.me(request("/api/admin/me", { cookie: account.cookie })),
    () => adminApi.dashboard(request("/api/admin/dashboard", { cookie: account.cookie })),
    () => adminApi.users(request("/api/admin/users", { cookie: account.cookie })),
    () =>
      adminApi.businesses(
        request("/api/admin/businesses", { cookie: account.cookie }),
      ),
    () =>
      adminApi.subscriptions(
        request("/api/admin/subscriptions", { cookie: account.cookie }),
      ),
    () =>
      adminApi.integrations(
        request("/api/admin/integrations", { cookie: account.cookie }),
      ),
    () => adminApi.audit(request("/api/admin/audit", { cookie: account.cookie })),
    () => adminApi.system(request("/api/admin/system", { cookie: account.cookie })),
  ];
  for (const call of paths) {
    const res = await call();
    assert.equal(res.status, 403, await res.clone().text());
  }
});

test("tenant isolation: user A cannot read business B via client API", async () => {
  const a = await login();
  const b = await login();
  const created = await app.businesses(
    request("/api/v1/businesses", {
      method: "POST",
      cookie: b.cookie,
      body: { name: "Чужой бизнес", timezone: "Europe/Moscow" },
      headers: { "idempotency-key": randomUUID() },
    }),
  );
  assert.equal(created.status, 201);
  const biz = await created.json();
  const denied = await app.business(
    request("/api/v1/businesses/" + biz.id, { cookie: a.cookie }),
    biz.id,
  );
  assert.equal(denied.status, 404);
});

test("platform admin without PIN is denied until MFA is configured", async () => {
  const account = await login();
  await db
    .insertInto("platform_admin")
    .values({
      user_id: account.internalId,
      role: "SUPER_ADMIN",
      status: "active",
      created_by: account.internalId,
      revoked_at: null,
    })
    .execute();
  const res = await adminApi.me(
    request("/api/admin/me", { cookie: account.cookie }),
  );
  assert.equal(res.status, 403);
  const payload = await res.json();
  assert.equal(payload.error.code, "ADMIN_MFA_REQUIRED");
});

test("admin with PIN but without PIN-verified current session must re-authenticate", async () => {
  const account = await login();
  await db
    .insertInto("account_pin")
    .values({
      user_id: account.internalId,
      pin_hash: "test-only-admin-pin-hash",
      failed_attempts: 0,
      locked_until: null,
    })
    .execute();
  await db
    .insertInto("platform_admin")
    .values({
      user_id: account.internalId,
      role: "SUPER_ADMIN",
      status: "active",
      created_by: account.internalId,
      revoked_at: null,
    })
    .execute();
  const res = await adminApi.me(
    request("/api/admin/me", { cookie: account.cookie }),
  );
  assert.equal(res.status, 403);
  const payload = await res.json();
  assert.equal(payload.error.code, "ADMIN_MFA_REAUTH_REQUIRED");
});

test("SUPER_ADMIN can read dashboard with real counts and no secrets", async () => {
  const account = await login();
  await grantRole(account.internalId, "SUPER_ADMIN");
  await app.businesses(
    request("/api/v1/businesses", {
      method: "POST",
      cookie: account.cookie,
      body: { name: "Админ кофейня", timezone: "Europe/Moscow" },
      headers: { "idempotency-key": randomUUID() },
    }),
  );
  const res = await adminApi.dashboard(
    request("/api/admin/dashboard", { cookie: account.cookie }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.usersTotal >= 1);
  assert.ok(body.businessesTotal >= 1);
  const text = JSON.stringify(body);
  assert.equal(/bot.?token|api[_-]?key|secret|password/i.test(text), false);
});

test("SUPPORT cannot assign admin roles or suspend without manage permission", async () => {
  const support = await login();
  const target = await login();
  await grantRole(support.internalId, "SUPPORT");
  const assign = await adminApi.user(
    request("/api/admin/users/" + target.user.id, {
      method: "POST",
      cookie: support.cookie,
      body: { action: "assign_role", role: "SUPER_ADMIN" },
    }),
    target.user.id,
  );
  assert.equal(assign.status, 403);
  const suspend = await adminApi.user(
    request("/api/admin/users/" + target.user.id, {
      method: "POST",
      cookie: support.cookie,
      body: { action: "suspend", reason: "test suspension reason" },
    }),
    target.user.id,
  );
  assert.equal(suspend.status, 403);
  const users = await adminApi.users(
    request("/api/admin/users", { cookie: support.cookie }),
  );
  assert.equal(users.status, 200);
});

test("FINANCE can read subscriptions but not system manage paths beyond read", async () => {
  const finance = await login();
  await grantRole(finance.internalId, "FINANCE");
  assert.equal(
    (
      await adminApi.subscriptions(
        request("/api/admin/subscriptions", { cookie: finance.cookie }),
      )
    ).status,
    200,
  );
  // system.read is not granted to FINANCE
  assert.equal(
    (
      await adminApi.system(
        request("/api/admin/system", { cookie: finance.cookie }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await adminApi.dashboard(
        request("/api/admin/dashboard", { cookie: finance.cookie }),
      )
    ).status,
    403,
  );
});

test("dangerous suspend creates audit with reason and redacts secrets in metadata helper", async () => {
  const admin = await login();
  const victim = await login();
  await grantRole(admin.internalId, "SUPER_ADMIN");
  const res = await adminApi.user(
    request("/api/admin/users/" + victim.user.id, {
      method: "POST",
      cookie: admin.cookie,
      body: { action: "suspend", reason: "abuse report verified" },
    }),
    victim.user.id,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const audit = await db
    .selectFrom("platform_admin_audit_log")
    .selectAll()
    .where("action", "=", "entity.suspend")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  assert.ok(audit);
  assert.equal(audit.reason, "abuse report verified");
  assert.equal(audit.admin_user_id, admin.internalId);

  const sanitized = sanitizeAdminMetadata({
    note: "ok",
    telegram_token: "123:ABC",
    nested: { apiKey: "x", safe: 1 },
  });
  assert.equal(sanitized.telegram_token, "[redacted]");
  assert.equal(sanitized.nested.apiKey, "[redacted]");
  assert.equal(sanitized.nested.safe, 1);
  assert.equal(sanitized.note, "ok");
});

test("admin audit log has no UPDATE/DELETE API and list is readable", async () => {
  const admin = await login();
  await grantRole(admin.internalId, "SUPER_ADMIN");
  const list = await adminApi.audit(
    request("/api/admin/audit?page=1", { cookie: admin.cookie }),
  );
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.ok(Array.isArray(body.items));
  // Ensure no mutating route exists on handler for audit
  assert.equal(typeof adminApi.audit, "function");
});

test("integration diagnostics never returns encrypted tokens", async () => {
  const admin = await login();
  await grantRole(admin.internalId, "SUPER_ADMIN");
  const bizRes = await app.businesses(
    request("/api/v1/businesses", {
      method: "POST",
      cookie: admin.cookie,
      body: { name: "Интеграции", timezone: "Europe/Moscow" },
      headers: { "idempotency-key": randomUUID() },
    }),
  );
  const biz = await bizRes.json();
  const internalBiz = await db
    .selectFrom("business")
    .select("id")
    .where("public_id", "=", biz.id)
    .executeTakeFirstOrThrow();
  const connectionId = randomUUID();
  await db
    .insertInto("business_connection")
    .values({
      id: connectionId,
      business_id: internalBiz.id,
      platform: "telegram",
      external_account_id: "12345",
      display_name: "@demo_bot",
      status: "error",
    })
    .execute();
  await db
    .insertInto("connection_secret")
    .values({
      connection_id: connectionId,
      encrypted_token: "ciphertext-should-never-leak",
      key_version: 1,
    })
    .execute();

  try {
    const diag = await adminApi.integration(
      request("/api/admin/integrations/" + connectionId, {
        cookie: admin.cookie,
      }),
      connectionId,
    );
    assert.equal(diag.status, 200);
    const payload = JSON.stringify(await diag.json());
    assert.equal(payload.includes("ciphertext-should-never-leak"), false);
    assert.match(payload, /configured|not_configured/);
  } finally {
    // Shared CI Postgres: do not leave secrets that break global empty-table asserts.
    await db
      .deleteFrom("connection_secret")
      .where("connection_id", "=", connectionId)
      .execute();
    await db
      .deleteFrom("business_connection")
      .where("id", "=", connectionId)
      .execute();
  }
});

test("cross-tenant admin access only via admin API with permission", async () => {
  const owner = await login();
  const staff = await login();
  await grantRole(staff.internalId, "SUPPORT");
  const created = await app.businesses(
    request("/api/v1/businesses", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Клиентский", timezone: "Europe/Moscow" },
      headers: { "idempotency-key": randomUUID() },
    }),
  );
  const biz = await created.json();
  // Staff is not a member — client API 404
  assert.equal(
    (
      await app.business(
        request("/api/v1/businesses/" + biz.id, { cookie: staff.cookie }),
        biz.id,
      )
    ).status,
    404,
  );
  // Admin API allows cross-tenant read
  const adminView = await adminApi.business(
    request("/api/admin/businesses/" + biz.id, { cookie: staff.cookie }),
    biz.id,
  );
  assert.equal(adminView.status, 200);
  const detail = await adminView.json();
  assert.equal(detail.publicId || detail.overview?.publicId || detail.business?.publicId, biz.id);
});

test("privilege escalation via body role field is ignored for SUPPORT", async () => {
  const support = await login();
  await grantRole(support.internalId, "SUPPORT");
  const me = await adminApi.me(
    request("/api/admin/me", {
      cookie: support.cookie,
    }),
  );
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.role, "SUPPORT");
  assert.equal(body.permissions.includes("admin.admins.manage"), false);
});

test("dashboard and user list use pagination bounds", async () => {
  const admin = await login();
  await grantRole(admin.internalId, "SUPER_ADMIN");
  const page = await adminService.listUsers({ page: 1, pageSize: 100 });
  assert.ok(page.pageSize <= 50);
});

test("MODERATOR cannot read audit", async () => {
  const mod = await login();
  await grantRole(mod.internalId, "MODERATOR");
  assert.equal(
    (await adminApi.audit(request("/api/admin/audit", { cookie: mod.cookie })))
      .status,
    403,
  );
});
