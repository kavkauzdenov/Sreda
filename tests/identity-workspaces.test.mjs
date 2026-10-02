import { betterAuth } from "better-auth";
import { verifyPassword } from "better-auth/crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect, PostgresDialect, sql } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { createIdentity } from "../src/server/identity/auth.ts";
import {
  acceptLogin,
  loginCredential,
} from "../src/server/identity/login-guard.ts";
import { WorkspaceService } from "../src/server/workspaces/service.ts";
import { InvitationService } from "../src/server/invitations/service.ts";
import { ConnectionService } from "../src/server/connections/service.ts";
import { LeadService } from "../src/server/leads/service.ts";
import { createApplication } from "../src/server/http/application.ts";
import { createAuthHandler } from "../src/server/http/auth-handler.ts";
import { createRecoveryHandler } from "../src/server/http/recovery-handler.ts";
import { createPasswordHandler } from "../src/server/http/password-handler.ts";
import { createPinHandler } from "../src/server/http/pin-handler.ts";
import { PinService } from "../src/server/identity/pin.ts";
import { RecoveryService } from "../src/server/identity/recovery.ts";
import { SolutionService } from "../src/server/solutions/service.ts";
import {
  TelegramService,
  webhookSecret,
} from "../src/server/telegram/service.ts";
import { createSolutionHandler } from "../src/server/http/solution-handler.ts";
import { migrate } from "../src/server/db/migrate.ts";

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
const invitations = new InvitationService(db);
const app = createApplication({ auth, workspaces, invitations, db, origin });
const authHandler = createAuthHandler({ db, auth, origin, secret });
const recoveryHandler = createRecoveryHandler({ db, auth, origin, secret });
const recovery = new RecoveryService(db);
const passwordHandler = createPasswordHandler({ db, auth, origin, secret });
const pinHandler = createPinHandler({ db, auth, origin, secret });
const pins = new PinService(db, secret);
function request(
  path,
  { method = "GET", body, cookie = "", headers = {} } = {},
) {
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
const signup = (username, confirmation = password) =>
  authHandler(
    request("/api/auth/sign-up/username", {
      method: "POST",
      body: { username, password, passwordConfirmation: confirmation },
    }),
  );
const signin = (username, value = password) =>
  authHandler(
    request("/api/auth/sign-in/username", {
      method: "POST",
      body: { username, password: value },
    }),
  );
const freshUsername = () => "u" + randomUUID().replaceAll("-", "").slice(0, 24);
async function login() {
  const username = freshUsername();
  const response = await signup(username);
  assert.equal(
    response.status,
    200,
    JSON.stringify(await response.clone().json()),
  );
  assert.deepEqual(await response.json(), { ok: true });
  const cookies = response.headers.getSetCookie();
  assert.ok(
    cookies.some(
      (cookie) => /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie),
    ),
  );
  const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
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
async function create(account, name = "Кофейня", key = randomUUID()) {
  return app.businesses(
    request("/api/v1/businesses", {
      method: "POST",
      cookie: account.cookie,
      body: { name, timezone: "Europe/Kaliningrad" },
      headers: { "idempotency-key": key },
    }),
  );
}
async function activateSolution(publicBusinessId, code = "leads") {
  const row = await db
    .selectFrom("business")
    .select("id")
    .where("public_id", "=", publicBusinessId)
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_solution")
    .values({
      business_id: row.id,
      solution_code: code,
      status: "active",
      starts_at: new Date(),
      expires_at: null,
    })
    .onConflict((oc) =>
      oc
        .columns(["business_id", "solution_code"])
        .doUpdateSet({ status: "active", expires_at: null, updated_at: new Date() }),
    )
    .execute();
}
before(async () => {
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
});
after(async () => {
  await db.destroy();
});

test("recovery issuance requires session, origin and current password; status exposes no codes", async () => {
  const account = await login();
  assert.equal((await recoveryHandler(request("/codes"), "codes")).status, 401);
  assert.equal(
    (
      await recoveryHandler(
        request("/codes", {
          method: "POST",
          cookie: account.cookie,
          headers: { origin: "https://evil.example" },
          body: { currentPassword: password },
        }),
        "codes",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await recoveryHandler(
        request("/codes", {
          method: "POST",
          cookie: account.cookie,
          body: { currentPassword: "wrong-password-123" },
        }),
        "codes",
      )
    ).status,
    400,
  );
  const issued = await recoveryHandler(
    request("/codes", {
      method: "POST",
      cookie: account.cookie,
      body: { currentPassword: password, userId: randomUUID() },
    }),
    "codes",
  );
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const { codes } = await issued.json();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const code of codes)
    assert.match(code, /^[A-F0-9]{4}(-[A-F0-9]{4}){7}$/);
  const rows = await db
    .selectFrom("recovery_code")
    .selectAll()
    .where("user_id", "=", account.internalId)
    .execute();
  assert.equal(rows.length, 8);
  assert.ok(
    rows.every(
      (row) =>
        !codes.includes(row.code_hash) &&
        !codes
          .map((c) => c.replaceAll("-", "").toLowerCase())
          .includes(row.code_hash),
    ),
  );
  const status = await (
    await recoveryHandler(
      request("/codes", { cookie: account.cookie }),
      "codes",
    )
  ).json();
  assert.deepEqual(Object.keys(status).sort(), ["issuedAt", "remaining"]);
  assert.equal(status.remaining, 8);
});

test("recovery consumes one code, resets password and revokes every existing session", async () => {
  const account = await login();
  await signin(account.username);
  const { codes } = await recovery.issue(account.internalId, password);
  const nextPassword = "new-test-password-56789";
  const body = {
    username: account.username.toUpperCase(),
    recoveryCode: codes[0],
    newPassword: nextPassword,
    passwordConfirmation: nextPassword,
  };
  await assert.rejects(
    recovery.recover({ ...body, passwordConfirmation: "mismatch" }),
    { status: 400 },
  );
  assert.equal((await recovery.status(account.internalId)).remaining, 8);
  const response = await recoveryHandler(
    request("/recover", { method: "POST", body }),
    "recover",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await recovery.status(account.internalId)).remaining, 7);
  assert.equal(
    (
      await db
        .selectFrom("session")
        .selectAll()
        .where("userId", "=", account.internalId)
        .execute()
    ).length,
    0,
  );
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: account.cookie }))).status,
    401,
  );
  assert.equal((await signin(account.username)).status, 400);
  assert.equal((await signin(account.username, nextPassword)).status, 200);
  await assert.rejects(recovery.recover(body), { code: "RECOVERY_FAILED" });
});

test("regeneration invalidates old codes; another user's code cannot reset an account", async () => {
  const a = await login();
  const b = await login();
  const first = await recovery.issue(a.internalId, password);
  const other = await recovery.issue(b.internalId, password);
  const second = await recovery.issue(a.internalId, password);
  const body = {
    username: a.username,
    newPassword: "changed-password-4321",
    passwordConfirmation: "changed-password-4321",
  };
  for (const recoveryCode of [
    first.codes[0],
    other.codes[0],
    "0000-".repeat(7) + "0000",
  ])
    await assert.rejects(recovery.recover({ ...body, recoveryCode }), {
      code: "RECOVERY_FAILED",
    });
  await recovery.recover({
    ...body,
    recoveryCode: second.codes[0].toLowerCase(),
  });
  assert.equal((await recovery.status(b.internalId)).remaining, 8);
  assert.equal((await signin(b.username)).status, 200);
});

test("failed recovery has generic errors, CSRF protection and rate limits", async () => {
  const account = await login();
  const { codes } = await recovery.issue(account.internalId, password);
  const body = {
    username: account.username,
    recoveryCode: "0".repeat(32),
    newPassword: "changed-password-4321",
    passwordConfirmation: "changed-password-4321",
  };
  assert.equal(
    (
      await recoveryHandler(
        request("/recover", {
          method: "POST",
          headers: { origin: "" },
          body: { ...body, recoveryCode: codes[0] },
        }),
        "recover",
      )
    ).status,
    403,
  );
  const missing = await recoveryHandler(
    request("/recover", {
      method: "POST",
      body: { ...body, username: freshUsername() },
    }),
    "recover",
  );
  const wrong = await recoveryHandler(
    request("/recover", { method: "POST", body }),
    "recover",
  );
  assert.equal(
    (await missing.json()).error.code,
    (await wrong.json()).error.code,
  );
  for (let i = 0; i < 4; i++)
    assert.equal(
      (
        await recoveryHandler(
          request("/recover", { method: "POST", body }),
          "recover",
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await recoveryHandler(
        request("/recover", {
          method: "POST",
          body: { ...body, recoveryCode: codes[0] },
        }),
        "recover",
      )
    ).status,
    429,
  );
  assert.equal((await recovery.status(account.internalId)).remaining, 8);
});

test("recovery rolls back consumed code, password and sessions if audit fails", async () => {
  const account = await login();
  const { codes } = await recovery.issue(account.internalId, password);
  await sql`ALTER TABLE account_security_event ADD CONSTRAINT reject_recovery_test CHECK (action <> 'password_recovered') NOT VALID`.execute(
    db,
  );
  try {
    await assert.rejects(
      recovery.recover({
        username: account.username,
        recoveryCode: codes[0],
        newPassword: "changed-password-4321",
        passwordConfirmation: "changed-password-4321",
      }),
    );
  } finally {
    await sql`ALTER TABLE account_security_event DROP CONSTRAINT reject_recovery_test`.execute(
      db,
    );
  }
  assert.equal((await recovery.status(account.internalId)).remaining, 8);
  assert.equal((await signin(account.username)).status, 200);
  assert.equal(
    (await app.me(request("/me", { cookie: account.cookie }))).status,
    200,
  );
});

test(
  "concurrent recovery cannot reuse a code on PostgreSQL",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires separate PostgreSQL connections",
  },
  async () => {
    const account = await login();
    const { codes } = await recovery.issue(account.internalId, password);
    const body = {
      username: account.username,
      recoveryCode: codes[0],
      newPassword: "changed-password-4321",
      passwordConfirmation: "changed-password-4321",
    };
    const results = await Promise.allSettled([
      recovery.recover(body),
      recovery.recover(body),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await recovery.status(account.internalId)).remaining, 7);
  },
);

test("no session cannot list or create businesses", async () => {
  assert.equal(
    (await app.businesses(request("/api/v1/businesses"))).status,
    401,
  );
  assert.equal(
    (
      await app.businesses(
        request("/api/v1/businesses", { method: "POST", body: {} }),
      )
    ).status,
    401,
  );
  assert.equal((await app.me(request("/api/v1/me"))).status, 401);
});
test("username signup and login; password hashed; JSON has no email or session token", async () => {
  const account = await login();
  assert.equal(account.user.username, account.username);
  assert.deepEqual(Object.keys(account.user).sort(), [
    "id",
    "name",
    "username",
  ]);
  const records =
    await sql`select password from account where "userId" = ${account.internalId}::uuid`.execute(
      db,
    );
  assert.ok(records.rows[0].password);
  assert.ok(!records.rows[0].password.includes(password));
  const response = await signin(account.username.toUpperCase());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await signup(account.username.toUpperCase())).status, 409);
});
test("mismatched passwords and invalid usernames do not create accounts", async () => {
  const username = freshUsername();
  assert.equal((await signup(username, "different-password")).status, 400);
  assert.equal((await signin(username)).status, 400);
  assert.equal((await signup("bad@login")).status, 400);
  assert.equal((await signup(username)).status, 200);
  assert.equal((await signin(username, "incorrect-password")).status, 400);
  for (const path of [
    "/sign-up/email",
    "/sign-in/email",
    "/email-otp/send-verification-otp",
    "/sign-in/email-otp",
  ]) {
    assert.equal(
      (
        await authHandler(
          request("/api/auth" + path, { method: "POST", body: {} }),
        )
      ).status,
      404,
    );
  }
});
test("failed password attempts are throttled", async () => {
  const account = await login();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await signin(account.username, "incorrect-password")).status,
      400,
    );
  assert.equal((await signin(account.username)).status, 429);
});
test("business creation is atomic and replay returns the same business", async () => {
  const account = await login();
  const key = randomUUID();
  const first = await create(account, "Зёрно", key);
  assert.equal(first.status, 201);
  const business = await first.json();
  assert.equal(business.ownerId, account.user.id);
  assert.equal(business.role, "owner");
  assert.equal(business.timezone, "Europe/Kaliningrad");
  assert.equal(
    (await (await create(account, "Зёрно", key)).json()).id,
    business.id,
  );
  assert.equal((await create(account, "Другое название", key)).status, 409);
  const internalBusiness = await db
    .selectFrom("business")
    .select("id")
    .where("public_id", "=", business.id)
    .executeTakeFirstOrThrow();
  const members = await db
    .selectFrom("business_member")
    .selectAll()
    .where("business_id", "=", internalBusiness.id)
    .execute();
  assert.equal(members.length, 1);
  assert.equal(
    (
      await (
        await app.businesses(
          request("/api/v1/businesses", { cookie: account.cookie }),
        )
      ).json()
    ).length,
    1,
  );
});
test("two users see only their businesses; unknown and foreign IDs return identical errors", async () => {
  const a = await login();
  const b = await login();
  const aBusiness = await (await create(a, "Бизнес А")).json();
  const bBusiness = await (await create(b, "Бизнес Б")).json();
  const list = await (
    await app.businesses(request("/api/v1/businesses", { cookie: a.cookie }))
  ).json();
  assert.deepEqual(
    list.map((item) => item.id),
    [aBusiness.id],
  );
  const foreign = await app.business(
    request("/api/v1/businesses/" + bBusiness.id, { cookie: a.cookie }),
    bBusiness.id,
  );
  const missing = await app.business(
    request("/api/v1/businesses/" + randomUUID(), { cookie: a.cookie }),
    randomUUID(),
  );
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  const f = (await foreign.json()).error;
  const m = (await missing.json()).error;
  assert.equal(f.code, m.code);
  assert.equal(f.message, m.message);
  assert.equal(
    (
      await app.business(
        request("/api/v1/businesses/" + aBusiness.id, { cookie: a.cookie }),
        aBusiness.id,
      )
    ).status,
    200,
  );
});
test("revoked membership denies the next request and operator cannot configure a business", async () => {
  const owner = await login();
  const operator = await login();
  const business = await (await create(owner)).json();
  const internalBusiness = await db
    .selectFrom("business")
    .select("id")
    .where("public_id", "=", business.id)
    .executeTakeFirstOrThrow();
  const internalOperator = await db
    .selectFrom("user")
    .select("id")
    .where("public_id", "=", operator.user.id)
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: internalBusiness.id,
      user_id: internalOperator.id,
      role: "operator",
      status: "active",
    })
    .execute();
  assert.equal(
    (await workspaces.require(operator.user.id, business.id)).role,
    "operator",
  );
  await assert.rejects(
    workspaces.require(operator.user.id, business.id, ["owner", "admin"]),
    { status: 403 },
  );
  await db
    .updateTable("business_member")
    .set({ status: "revoked" })
    .where("business_id", "=", internalBusiness.id)
    .where("user_id", "=", internalOperator.id)
    .execute();
  assert.equal(
    (
      await app.business(
        request("/api/v1/businesses/" + business.id, {
          cookie: operator.cookie,
        }),
        business.id,
      )
    ).status,
    404,
  );
});
test("database rejects a second owner and rolls back an orphan business", async () => {
  const owner = await login();
  const other = await login();
  const business = await (await create(owner)).json();
  const internalBusiness = await db
    .selectFrom("business")
    .select("id")
    .where("public_id", "=", business.id)
    .executeTakeFirstOrThrow();
  const internalOther = await db
    .selectFrom("user")
    .select("id")
    .where("public_id", "=", other.user.id)
    .executeTakeFirstOrThrow();
  await assert.rejects(
    db
      .insertInto("business_member")
      .values({
        business_id: internalBusiness.id,
        user_id: internalOther.id,
        role: "owner",
        status: "active",
      })
      .execute(),
  );
  const before = await db.selectFrom("business").select("id").execute();
  await assert.rejects(
    workspaces.create(
      randomUUID(),
      { name: "Не сохранится", timezone: "UTC" },
      randomUUID(),
    ),
  );
  assert.equal(
    (await db.selectFrom("business").select("id").execute()).length,
    before.length,
  );
});
test("forged body, missing idempotency key, oversized body and CSRF are rejected", async () => {
  const account = await login();
  const base = {
    method: "POST",
    cookie: account.cookie,
    body: { name: "Бизнес", timezone: "UTC" },
  };
  assert.equal(
    (await app.businesses(request("/api/v1/businesses", base))).status,
    400,
  );
  assert.equal(
    (
      await app.businesses(
        request("/api/v1/businesses", {
          ...base,
          headers: { origin: "https://evil.example" },
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await app.businesses(
        request("/api/v1/businesses", { ...base, headers: { origin: "" } }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await app.businesses(
        request("/api/v1/businesses", {
          ...base,
          body: { ...base.body, ownerId: randomUUID() },
          headers: { "idempotency-key": randomUUID() },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await app.businesses(
        request("/api/v1/businesses", {
          ...base,
          body: { ...base.body, name: "А".repeat(5000) },
        }),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await authHandler(
        request("/api/auth/sign-out", {
          method: "POST",
          body: {},
          headers: { origin: "https://evil.example" },
        }),
      )
    ).status,
    403,
  );
});
test("logout revokes server session immediately, expired sessions are rejected", async () => {
  const account = await login();
  const response = await authHandler(
    request("/api/auth/sign-out", {
      method: "POST",
      cookie: account.cookie,
      body: {},
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: account.cookie }))).status,
    401,
  );
  const expired = await login();
  await sql`update session set "expiresAt" = now() - interval '1 second' where "userId" = ${expired.internalId}::uuid`.execute(
    db,
  );
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: expired.cookie }))).status,
    401,
  );
});
test("owner invites a user, acceptance creates membership, and duplicate invite is rejected", async () => {
  const owner = await login();
  const invitee = await login();
  const business = await (await create(owner, "Команда")).json();
  const invite = await app.invitations(
    request(`/api/v1/businesses/${business.id}/invitations`, {
      method: "POST",
      cookie: owner.cookie,
      body: { userId: invitee.user.id, role: "admin" },
    }),
    business.id,
  );
  assert.equal(invite.status, 201);
  const invitation = await invite.json();
  assert.equal(
    (
      await app.invitations(
        request("/api/v1/invitations", { cookie: invitee.cookie }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await app.invitations(
        request(`/api/v1/businesses/${business.id}/invitations`, {
          method: "POST",
          cookie: owner.cookie,
          body: { userId: invitee.user.id, role: "admin" },
        }),
        business.id,
      )
    ).status,
    409,
  );
  const accepted = await app.invitations(
    request(`/api/v1/invitations/${invitation.id}/accept`, {
      method: "POST",
      cookie: invitee.cookie,
      body: {},
    }),
    invitation.id,
    "accept",
  );
  assert.equal(accepted.status, 200);
  assert.equal(
    (await workspaces.require(invitee.user.id, business.id)).role,
    "admin",
  );
});
test("operator cannot invite, and owner can revoke a pending invitation", async () => {
  const owner = await login();
  const operator = await login();
  const target = await login();
  const business = await (await create(owner, "Доступ")).json();
  const internalBusiness = await db
    .selectFrom("business")
    .select("id")
    .where("public_id", "=", business.id)
    .executeTakeFirstOrThrow();
  const internalOperator = await db
    .selectFrom("user")
    .select("id")
    .where("public_id", "=", operator.user.id)
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: internalBusiness.id,
      user_id: internalOperator.id,
      role: "operator",
      status: "active",
    })
    .execute();
  assert.equal(
    (
      await app.invitations(
        request(`/api/v1/businesses/${business.id}/invitations`, {
          method: "POST",
          cookie: operator.cookie,
          body: { userId: target.user.id, role: "operator" },
        }),
        business.id,
      )
    ).status,
    403,
  );
  const created = await app.invitations(
    request(`/api/v1/businesses/${business.id}/invitations`, {
      method: "POST",
      cookie: owner.cookie,
      body: { userId: target.user.id, role: "operator" },
    }),
    business.id,
  );
  const invitation = await created.json();
  assert.equal(
    (
      await app.invitations(
        request(
          `/api/v1/businesses/${business.id}/invitations/${invitation.id}`,
          { method: "POST", cookie: owner.cookie, body: {} },
        ),
        business.id,
        invitation.id,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await app.invitations(
        request(`/api/v1/invitations/${invitation.id}/accept`, {
          method: "POST",
          cookie: target.cookie,
          body: {},
        }),
        invitation.id,
        "accept",
      )
    ).status,
    404,
  );
});
test(
  "concurrent creation is deduplicated across PostgreSQL connections",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "PGlite has one connection; concurrency runs against PostgreSQL in CI",
  },
  async () => {
    const account = await login();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(account, "Один бизнес", key)),
    );
    for (const result of results) assert.equal(result.status, 201);
    const ids = await Promise.all(
      results.map(async (result) => (await result.json()).id),
    );
    assert.equal(new Set(ids).size, 1);
  },
);
test(
  "parallel signup cannot duplicate a username on PostgreSQL",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires separate PostgreSQL connections",
  },
  async () => {
    const username = freshUsername();
    const results = await Promise.all([signup(username), signup(username)]);
    assert.equal(
      results.filter((response) => response.status === 200).length,
      1,
    );
    const records =
      await sql`select id from "user" where username = ${username}`.execute(db);
    assert.equal(records.rows.length, 1);
  },
);

test("invitation history allows re-invites, expired invitations and revoked access stay invalid", async () => {
  const owner = await login();
  const member = await login();
  const business = await (await create(owner)).json();
  const first = await invitations.create(
    owner.internalId,
    business.id,
    member.user.id,
    "admin",
  );
  assert.equal(first.businessId, business.id);
  await db
    .updateTable("business_invitation")
    .set({ expires_at: new Date(0) })
    .where("id", "=", first.id)
    .execute();
  const second = await invitations.create(
    owner.internalId,
    business.id,
    member.user.id,
    "operator",
  );
  await assert.rejects(invitations.accept(member.internalId, first.id), {
    status: 404,
  });
  await invitations.accept(member.internalId, second.id);
  await assert.rejects(
    invitations.create(owner.internalId, business.id, member.user.id, "admin"),
    { status: 409 },
  );
  await invitations.changeRole(
    owner.internalId,
    business.id,
    member.user.id,
    "admin",
  );
  await invitations.revokeMember(owner.internalId, business.id, member.user.id);
  await assert.rejects(invitations.accept(member.internalId, second.id), {
    status: 404,
  });
  for (let i = 0; i < 2; i++) {
    const next = await invitations.create(
      owner.internalId,
      business.id,
      member.user.id,
      "operator",
    );
    await invitations.revoke(owner.internalId, business.id, next.id);
  }
  const final = await invitations.create(
    owner.internalId,
    business.id,
    member.user.id,
    "operator",
  );
  await invitations.accept(member.internalId, final.id);
  assert.equal(
    (await workspaces.require(member.user.id, business.id)).role,
    "operator",
  );
  await assert.rejects(
    invitations.changeRole(
      owner.internalId,
      business.id,
      owner.user.id,
      "operator",
    ),
    { status: 404 },
  );
  const unknown = await app.members(
    request("/members", {
      method: "POST",
      cookie: owner.cookie,
      body: { action: "typo", userId: member.user.id },
    }),
    business.id,
  );
  assert.equal(unknown.status, 400);
  assert.equal(
    (await workspaces.require(member.user.id, business.id)).role,
    "operator",
  );
});

test("membership mutation and audit are atomic; archived business rejects invitations", async () => {
  const owner = await login();
  const member = await login();
  const business = await (await create(owner)).json();
  const invited = await invitations.create(
    owner.internalId,
    business.id,
    member.user.id,
    "admin",
  );
  await invitations.accept(member.internalId, invited.id);
  await db.transaction().execute(async (tx) => {
    await sql`ALTER TABLE business_audit_log ADD CONSTRAINT test_reject_revoke CHECK (action <> 'member_revoked') NOT VALID`.execute(
      tx,
    );
  });
  try {
    await assert.rejects(
      invitations.revokeMember(owner.internalId, business.id, member.user.id),
    );
  } finally {
    await sql`ALTER TABLE business_audit_log DROP CONSTRAINT test_reject_revoke`.execute(
      db,
    );
  }
  assert.equal(
    (await workspaces.require(member.user.id, business.id)).role,
    "admin",
  );
  const audit = await invitations.auditLog(owner.internalId, business.id);
  assert.ok(
    audit.every(
      (entry) => entry.actorUserId.startsWith("usr_") && entry.actorUsername,
    ),
  );
  await db
    .updateTable("business")
    .set({ archived_at: new Date() })
    .where("public_id", "=", business.id)
    .execute();
  await assert.rejects(invitations.members(owner.internalId, business.id), {
    status: 404,
  });
  assert.equal(
    (await invitations.list(member.internalId)).some(
      (item) => item.businessId === business.id,
    ),
    false,
  );
});

test("connections verify bot, encrypt token, enforce scope and delete secret through API", async () => {
  const owner = await login();
  const stranger = await login();
  const business = await (await create(owner)).json();
  const other = await (await create(stranger)).json();
  const token = "123456789:fake-test-token-not-a-credential";
  const connections = new ConnectionService(
    db,
    secret,
    async (_url, options) => {
      assert.equal(options.redirect, "error");
      return Response.json({
        ok: true,
        result: { id: 123456789, is_bot: true, username: "test_bot" },
      });
    },
  );
  const application = createApplication({
    auth,
    workspaces,
    db,
    connections,
    origin,
  });
  await connections.connect(owner.internalId, business.id, {
    platform: "telegram",
    token,
  });
  const stored = await db.selectFrom("connection_secret").selectAll().execute();
  assert.ok(
    stored.length > 0 &&
      stored.every((item) => !item.encrypted_token.includes(token)),
  );
  assert.ok(
    !JSON.stringify(
      await connections.list(owner.internalId, business.id),
    ).includes(token),
  );
  await assert.rejects(
    connections.connect(stranger.internalId, other.id, {
      platform: "telegram",
      token,
    }),
    { status: 409 },
  );
  await assert.rejects(
    connections.disconnect(stranger.internalId, business.id, "telegram"),
    { status: 404 },
  );
  assert.equal(
    (
      await application.connections(
        request("/connections?platform=telegram", {
          method: "DELETE",
          cookie: owner.cookie,
          headers: { origin: "https://evil.example" },
        }),
        business.id,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await application.connections(
        request("/connections?platform=telegram", {
          method: "DELETE",
          cookie: owner.cookie,
        }),
        business.id,
      )
    ).status,
    200,
  );
  const internalBusiness = await db
    .selectFrom("business")
    .select("id")
    .where("public_id", "=", business.id)
    .executeTakeFirstOrThrow();
  assert.equal(
    (
      await db
        .selectFrom("connection_secret as s")
        .innerJoin("business_connection as c", "c.id", "s.connection_id")
        .where("c.business_id", "=", internalBusiness.id)
        .select("s.connection_id")
        .execute()
    ).length,
    0,
  );
  assert.equal(
    (await connections.list(owner.internalId, business.id))[0].status,
    "disconnected",
  );
  await connections.connect(stranger.internalId, other.id, {
    platform: "telegram",
    token,
  });
});

test("leads are scoped, return public business ID and deduplicate channel event", async () => {
  const owner = await login();
  const stranger = await login();
  const business = await (await create(owner)).json();
  await activateSolution(business.id, "leads");
  const leads = new LeadService(db);
  const input = {
    source: "telegram",
    name: "Клиент",
    externalEventId: "event-1",
  };
  const first = await leads.create(owner.internalId, business.id, input);
  assert.equal(first.businessId, business.id);
  assert.equal(
    (await leads.create(owner.internalId, business.id, input)).id,
    first.id,
  );
  await assert.rejects(
    leads.updateStatus(stranger.internalId, business.id, first.id, "closed"),
    { status: 404 },
  );
  assert.equal(
    (
      await leads.updateStatus(
        owner.internalId,
        business.id,
        first.id,
        "closed",
      )
    ).businessId,
    business.id,
  );
  await assert.rejects(
    leads.updateStatus(owner.internalId, business.id, "invalid", "closed"),
    { status: 404 },
  );
  assert.equal((await leads.list(owner.internalId, business.id)).length, 1);
});

test(
  "parallel invitation acceptance and lead replay serialize on PostgreSQL",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires separate PostgreSQL connections",
  },
  async () => {
    const owner = await login();
    const member = await login();
    const business = await (await create(owner)).json();
    await activateSolution(business.id, "leads");
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        invitations.create(
          owner.internalId,
          business.id,
          member.user.id,
          "operator",
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const invitation = results.find((r) => r.status === "fulfilled").value;
    const accepted = await Promise.allSettled([
      invitations.accept(member.internalId, invitation.id),
      invitations.accept(member.internalId, invitation.id),
    ]);
    assert.equal(accepted.filter((r) => r.status === "fulfilled").length, 1);
    const leads = new LeadService(db);
    const created = await Promise.all(
      Array.from({ length: 4 }, () =>
        leads.create(owner.internalId, business.id, {
          source: "telegram",
          name: "Клиент",
          externalEventId: "concurrent-1",
        }),
      ),
    );
    assert.equal(new Set(created.map((item) => item.id)).size, 1);
  },
);

test("password change retains current session, revokes others and preserves recovery codes and other users", async () => {
  const a = await login();
  const b = await login();
  const second = await signin(a.username);
  const secondCookie = second.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const { codes } = await recovery.issue(a.internalId, password);
  const next = "changed-password-98765";
  const response = await passwordHandler(
    request("/password", {
      method: "POST",
      cookie: a.cookie,
      body: {
        currentPassword: password,
        newPassword: next,
        passwordConfirmation: next,
        userId: b.internalId,
        revokeOtherSessions: false,
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: a.cookie }))).status,
    200,
  );
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: secondCookie }))).status,
    401,
  );
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: b.cookie }))).status,
    200,
  );
  assert.equal((await signin(a.username)).status, 400);
  assert.equal((await signin(a.username, next)).status, 200);
  assert.equal((await signin(b.username)).status, 200);
  assert.equal((await recovery.status(a.internalId)).remaining, 8);
  await recovery.recover({
    username: a.username,
    recoveryCode: codes[0],
    newPassword: password,
    passwordConfirmation: password,
  });
  const events = await db
    .selectFrom("account_security_event")
    .select("action")
    .where("user_id", "=", a.internalId)
    .where("action", "=", "password_changed")
    .execute();
  assert.equal(events.length, 1);
});

test("password change requires session, origin, matching passwords and limits guesses", async () => {
  const a = await login();
  const next = "changed-password-98765";
  const body = {
    currentPassword: password,
    newPassword: next,
    passwordConfirmation: next,
  };
  const call = (patch = {}, headers = {}) =>
    passwordHandler(
      request("/password", {
        method: "POST",
        cookie: a.cookie,
        body: { ...body, ...patch },
        headers,
      }),
    );
  assert.equal(
    (await passwordHandler(request("/password", { method: "POST", body })))
      .status,
    401,
  );
  assert.equal(
    (await passwordHandler(request("/password", { cookie: a.cookie }))).status,
    405,
  );
  assert.equal(
    (await call({}, { origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await call({ passwordConfirmation: "mismatch" })).status, 400);
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await call({ currentPassword: "wrong-password-1234" })).status,
      400,
    );
  assert.equal((await call()).status, 429);
  assert.equal((await signin(a.username)).status, 200);
});

test("password change rolls back credential and session changes when audit fails", async () => {
  const a = await login();
  await signin(a.username);
  const before = await db
    .selectFrom("session")
    .select("id")
    .where("userId", "=", a.internalId)
    .execute();
  await sql`ALTER TABLE account_security_event ADD CONSTRAINT reject_change_test CHECK (action <> 'password_changed') NOT VALID`.execute(
    db,
  );
  try {
    const result = await passwordHandler(
      request("/password", {
        method: "POST",
        cookie: a.cookie,
        body: {
          currentPassword: password,
          newPassword: "changed-password-98765",
          passwordConfirmation: "changed-password-98765",
        },
      }),
    );
    assert.equal(result.status, 503);
  } finally {
    await sql`ALTER TABLE account_security_event DROP CONSTRAINT reject_change_test`.execute(
      db,
    );
  }
  const after = await db
    .selectFrom("session")
    .select("id")
    .where("userId", "=", a.internalId)
    .execute();
  assert.deepEqual(
    after.map((s) => s.id).sort(),
    before.map((s) => s.id).sort(),
  );
  assert.equal((await signin(a.username)).status, 200);
});

test(
  "concurrent password changes cannot both accept the old password on PostgreSQL",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires separate PostgreSQL connections",
  },
  async () => {
    const a = await login();
    const call = (next) =>
      passwordHandler(
        request("/password", {
          method: "POST",
          cookie: a.cookie,
          body: {
            currentPassword: password,
            newPassword: next,
            passwordConfirmation: next,
          },
        }),
      );
    const results = await Promise.all([
      call("concurrent-password-one"),
      call("concurrent-password-two"),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    const events = await db
      .selectFrom("account_security_event")
      .select("id")
      .where("user_id", "=", a.internalId)
      .where("action", "=", "password_changed")
      .execute();
    assert.equal(events.length, 1);
  },
);

// Pause the real library after it has verified a password, before it inserts a
// session. Explicit barriers make the formerly vulnerable ordering deterministic.

// A fresh betterAuth instance registers its own runtime schema check, and its
// first request awaits database introspection inside better-auth's onRequest —
// outside better-call's error boundary. A transient database error there fails
// the in-flight sign-in before the password barrier and misreports the race.
// Schema drift is asserted by the dedicated migration tests instead.
function createBarrierAuth(verify) {
  return betterAuth({
    ...auth.options,
    advanced: {
      ...auth.options.advanced,
      database: { ...auth.options.advanced.database, validateSchema: false },
    },
    emailAndPassword: {
      ...auth.options.emailAndPassword,
      password: { verify },
    },
  });
}

for (const operation of ["change", "recover"]) {
  test(
    `in-flight login cannot survive password ${operation}`,
    { timeout: 20000 },
    async () => {
      await assertInFlightLoginCannotSurvive(operation);
    },
  );
}

async function assertInFlightLoginCannotSurvive(operation) {
      const a = await login();
      const other = await login();
      const { codes } = await recovery.issue(a.internalId, password);
      const verified = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const delayedAuth = createBarrierAuth(async (input) => {
        const valid = await verifyPassword(input);
        verified.resolve();
        await resume.promise;
        return valid;
      });
      const handler = createAuthHandler({
        db,
        auth: delayedAuth,
        origin,
        secret,
      });
      const pending = handler(
        request("/api/auth/sign-in/username", {
          method: "POST",
          body: { username: a.username, password },
        }),
      );
      const next = "race-safe-password-12345";
      try {
        await Promise.race([
          verified.promise,
          pending.then(async (early) => {
            const detail = await early
              .clone()
              .text()
              .catch(() => "");
            throw new Error(
              `Login finished before verification barrier: HTTP ${early.status} ${detail}`,
            );
          }),
        ]);
        if (operation === "change") {
          const changed = await passwordHandler(
            request("/password", {
              method: "POST",
              cookie: a.cookie,
              body: {
                currentPassword: password,
                newPassword: next,
                passwordConfirmation: next,
              },
            }),
          );
          assert.equal(changed.status, 200);
        } else {
          await recovery.recover({
            username: a.username,
            recoveryCode: codes[0],
            newPassword: next,
            passwordConfirmation: next,
          });
        }
      } finally {
        resume.resolve();
      }
      const response = await pending;
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "AUTH_FAILED");
      assert.deepEqual(response.headers.getSetCookie(), []);
      const remaining = await db
        .selectFrom("session")
        .select("id")
        .where("userId", "=", a.internalId)
        .execute();
      assert.equal(remaining.length, operation === "change" ? 1 : 0);
      assert.equal(
        (await app.me(request("/api/v1/me", { cookie: other.cookie }))).status,
        200,
      );
      assert.equal((await signin(a.username, next)).status, 200);
      assert.equal((await signin(a.username)).status, 400);
}

test("login completed before password reset is revoked by reset", async () => {
  const a = await login();
  const { codes } = await recovery.issue(a.internalId, password);
  const signedIn = await signin(a.username);
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  await recovery.recover({
    username: a.username,
    recoveryCode: codes[0],
    newPassword: "reverse-race-password-1234",
    passwordConfirmation: "reverse-race-password-1234",
  });
  assert.equal((await app.me(request("/api/v1/me", { cookie }))).status, 401);
});

test("dashboard lead service reads real API data for the selected business and surfaces access failures", async () => {
  const { getRecentLeads } = await import("../src/services/leads.service.ts");
  const owner = await login();
  const stranger = await login();
  const a = await (await create(owner, "Первый бизнес")).json();
  const b = await (await create(owner, "Второй бизнес")).json();
  await activateSolution(a.id, "leads");
  await activateSolution(b.id, "leads");
  const leads = new LeadService(db);
  const application = createApplication({
    auth,
    workspaces,
    invitations,
    db,
    origin,
    leads,
  });
  const expected = [];
  for (let i = 0; i < 4; i++) {
    const lead = await leads.create(owner.internalId, a.id, {
      source: i % 2 ? "vk" : "telegram",
      name: "Клиент " + i,
      phone: "+79990000000",
      message: "Сообщение " + i,
    });
    await db
      .updateTable("lead")
      .set({ created_at: new Date(Date.UTC(2026, 0, i + 1)) })
      .where("id", "=", lead.id)
      .execute();
    expected.unshift(lead.id);
  }
  const other = await leads.create(owner.internalId, b.id, {
    source: "telegram",
    name: "Другой клиент",
  });
  const originalFetch = globalThis.fetch;
  let cookie = owner.cookie;
  globalThis.fetch = async (path, init) => {
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    const match = /^\/api\/v1\/businesses\/([^/]+)\/leads$/.exec(path);
    assert.ok(match, "Client must use business-scoped leads endpoint");
    return application.leads(
      request(path, { cookie }),
      decodeURIComponent(match[1]),
    );
  };
  try {
    const first = await getRecentLeads(a.id, 3);
    assert.deepEqual(
      first.map((l) => l.id),
      expected.slice(0, 3),
    );
    assert.ok(
      first.every((l) => l.businessId === a.id && l.phone === "+79990000000"),
    );
    assert.deepEqual(
      (await getRecentLeads(b.id, 3)).map((l) => l.id),
      [other.id],
    );
    await leads.updateStatus(owner.internalId, a.id, first[0].id, "processing");
    assert.equal((await getRecentLeads(a.id, 3))[0].status, "processing");
    cookie = stranger.cookie;
    await assert.rejects(getRecentLeads(a.id, 3), { status: 404 });
    cookie = "";
    await assert.rejects(getRecentLeads(a.id, 3), { status: 401 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lead pages filter on the server, keep equal timestamps and avoid repeats after new arrivals", async () => {
  const owner = await login();
  const a = await (await create(owner)).json();
  await activateSolution(a.id, "leads");
  const internal = await db
    .selectFrom("business")
    .select("id")
    .where("public_id", "=", a.id)
    .executeTakeFirstOrThrow();
  const rows = Array.from({ length: 105 }, () => ({
    id: randomUUID(),
    business_id: internal.id,
    source: "telegram",
    name: "Клиент",
    phone: null,
    message: null,
    status: "new",
    external_event_id: null,
    created_at: new Date("2026-01-01T10:00:00.123Z"),
  }));
  await db.insertInto("lead").values(rows).execute();
  await sql`UPDATE lead SET created_at = '2026-01-01T10:00:00.123456Z'::timestamptz WHERE business_id = ${internal.id}::uuid`.execute(
    db,
  );
  const leads = new LeadService(db);
  const first = await leads.list(owner.internalId, a.id, "new");
  assert.equal(first.length, 100);
  const last = first.at(-1);
  const cursor = `${last.createdAt}|${last.id}`;
  const incoming = await leads.create(owner.internalId, a.id, {
    source: "vk",
    name: "Новое обращение",
  });
  const second = await leads.list(owner.internalId, a.id, "new", cursor);
  assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 105);
  assert.ok(!second.some((row) => row.id === incoming.id));
  await leads.updateStatus(owner.internalId, a.id, first[0].id, "closed");
  assert.deepEqual(
    (await leads.list(owner.internalId, a.id, "closed")).map((row) => row.id),
    [first[0].id],
  );
  await assert.rejects(
    leads.list(owner.internalId, a.id, undefined, "bad|cursor"),
    { status: 400 },
  );
});

test("lead page client saves statuses through scoped API and loses access after revocation", async () => {
  const { getLeadPage, updateLeadStatus } = await import(
    "../src/services/leads.service.ts"
  );
  const owner = await login();
  const operator = await login();
  const other = await (await create(owner)).json();
  const business = await (await create(owner)).json();
  await activateSolution(business.id, "leads");
  const leads = new LeadService(db);
  const application = createApplication({
    auth,
    workspaces,
    invitations,
    db,
    origin,
    leads,
  });
  const invitation = await invitations.create(
    owner.internalId,
    business.id,
    operator.user.id,
    "operator",
  );
  await invitations.accept(operator.internalId, invitation.id);
  const row = await leads.create(owner.internalId, business.id, {
    source: "telegram",
    name: "Клиент",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    const url = new URL(path, origin);
    const parts = url.pathname.split("/");
    const req = request(url.pathname + url.search, {
      method: init.method || "GET",
      cookie: operator.cookie,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return parts[6]
      ? application.leadStatus(req, parts[4], parts[6])
      : application.leads(req, parts[4]);
  };
  try {
    assert.equal((await getLeadPage(business.id, "new")).length, 1);
    assert.equal(
      (await updateLeadStatus(business.id, row.id, "processing")).status,
      "processing",
    );
    assert.equal((await getLeadPage(business.id, "new")).length, 0);
    assert.equal((await getLeadPage(business.id, "processing"))[0].id, row.id);
    await assert.rejects(updateLeadStatus(other.id, row.id, "closed"), {
      status: 404,
    });
    await invitations.revokeMember(
      owner.internalId,
      business.id,
      operator.user.id,
    );
    await assert.rejects(updateLeadStatus(business.id, row.id, "closed"), {
      status: 404,
    });
    await assert.rejects(getLeadPage(business.id), { status: 404 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const readyDraft = {
  version: 1,
  step: 3,
  channels: ["telegram"],
  fields: ["name", "phone", "service"],
};
async function botFixture(fields = readyDraft.fields) {
  const owner = await login();
  const business = await (await create(owner)).json();
  const calls = [];
  const transport = async (url, init) => {
    if (url.endsWith("/getMe"))
      return Response.json({
        ok: true,
        result: {
          id: Number.parseInt(randomUUID().slice(0, 8), 16),
          is_bot: true,
          username: "fixture_bot",
        },
      });
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return Response.json({
      ok: true,
      result: url.endsWith("/sendMessage")
        ? { message_id: calls.length }
        : true,
    });
  };
  const connections = new ConnectionService(db, secret, transport);
  await connections.connect(owner.internalId, business.id, {
    platform: "telegram",
    token: "test-only-bot-token-12345",
  });
  const connection = (await connections.list(owner.internalId, business.id))[0];
  const solutions = new SolutionService(db, true);
  await solutions.save(owner.internalId, business.id, {
    draft: { ...readyDraft, fields },
    revision: 0,
  });
  const telegram = new TelegramService(
    db,
    secret,
    "https://sreda.test",
    true,
    transport,
  );
  await telegram.start(owner.internalId, business.id);
  const runtime = await db
    .selectFrom("telegram_runtime")
    .selectAll()
    .where("connection_id", "=", connection.id)
    .executeTakeFirstOrThrow();
  const header = webhookSecret(secret, connection.id, runtime.generation);
  const send = (update, text, chat = 123) =>
    telegram.receive(connection.id, header, {
      update_id: update,
      message: {
        text,
        chat: { id: chat, type: "private" },
        from: { id: chat, is_bot: false },
      },
    });
  return {
    owner,
    business,
    calls,
    connections,
    connection,
    solutions,
    telegram,
    header,
    send,
    transport,
  };
}

test("setup persists per business, validates fields, rejects operators and concurrent edits", async () => {
  const owner = await login();
  const operator = await login();
  const outsider = await login();
  const a = await (await create(owner)).json();
  const b = await (await create(owner)).json();
  const service = new SolutionService(db);
  assert.equal((await service.get(owner.internalId, a.id)).revision, 0);
  const saved = await service.save(owner.internalId, a.id, {
    draft: readyDraft,
    revision: 0,
  });
  assert.equal(saved.revision, 1);
  const loaded = await new SolutionService(db).get(owner.internalId, a.id);
  assert.equal(loaded.draft.version, 2);
  assert.deepEqual(loaded.draft.channels, readyDraft.channels);
  assert.equal(loaded.draft.completed, true);
  assert.equal(loaded.draft.buttonLabel, "Оставить заявку");
  assert.equal((await service.get(owner.internalId, b.id)).revision, 0);
  await assert.rejects(
    service.save(owner.internalId, a.id, { draft: readyDraft, revision: 0 }),
    { status: 409 },
  );
  await assert.rejects(
    service.save(owner.internalId, a.id, {
      draft: { ...readyDraft, fields: ["phone"] },
      revision: 1,
    }),
    { status: 400 },
  );
  await assert.rejects(service.get(outsider.internalId, a.id), { status: 404 });
  const invite = await invitations.create(
    owner.internalId,
    a.id,
    operator.user.id,
    "operator",
  );
  await invitations.accept(operator.internalId, invite.id);
  assert.equal((await service.get(operator.internalId, a.id)).revision, 1);
  await assert.rejects(
    service.save(operator.internalId, a.id, { draft: readyDraft, revision: 1 }),
    { status: 403 },
  );
  const handler = createSolutionHandler({ db, auth, origin, secret });
  assert.equal(
    (
      await handler(
        request("/setup", {
          method: "POST",
          cookie: owner.cookie,
          headers: { origin: "https://evil.example" },
          body: { draft: readyDraft, revision: 1 },
        }),
        a.id,
        "setup",
      )
    ).status,
    403,
  );
  assert.equal((await handler(request("/setup"), a.id, "setup")).status, 401);
});

test("Telegram activation requires saved configuration, verified token and enabled deployment", async () => {
  const owner = await login();
  const business = await (await create(owner)).json();
  const solutions = new SolutionService(db, true);
  const tg = new TelegramService(db, secret, origin, true);
  await assert.rejects(tg.start(owner.internalId, business.id), {
    status: 400,
  });
  await solutions.save(owner.internalId, business.id, {
    draft: readyDraft,
    revision: 0,
  });
  await assert.rejects(tg.start(owner.internalId, business.id), {
    code: "CONNECTION_REQUIRED",
  });
  await assert.rejects(
    new TelegramService(db, secret, origin, false).start(
      owner.internalId,
      business.id,
    ),
    { status: 503 },
  );
  assert.equal(
    (await solutions.list(owner.internalId, business.id))[0].status,
    "setup_required",
  );
});

test("Telegram dialogue persists, isolates chats, deduplicates updates and creates a business lead", async () => {
  const f = await botFixture();
  await assert.rejects(
    f.telegram.receive(f.connection.id, "0".repeat(64), { update_id: 1 }),
    { status: 403 },
  );
  await f.send(1, "Оставить заявку");
  await f.send(2, "Анна");
  await f.send(3, "/skip");
  await f.send(4, "/start", 456);
  await f.send(5, "Запись на завтра");
  await f.send(5, "Запись на завтра");
  await f.send(6, "Отправить");
  await f.send(6, "Отправить");
  const leads = await new LeadService(db).list(
    f.owner.internalId,
    f.business.id,
  );
  assert.equal(leads.length, 1);
  assert.equal(leads[0].name, "Анна");
  assert.equal(leads[0].message, "Запись на завтра");
  assert.equal(leads[0].phone, undefined);
  const dialogs = await db
    .selectFrom("telegram_dialog")
    .selectAll()
    .where("connection_id", "=", f.connection.id)
    .execute();
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs.find((d) => d.chat_id === "123").mode, "menu");
  const anotherInstance = new TelegramService(
    db,
    secret,
    "https://sreda.test",
    true,
    f.transport,
  );
  // PostgreSQL suites share a database; drain the current queue rather than
  // assuming this fixture owns the first twenty global jobs.
  const queuedCount = await db
    .selectFrom("telegram_outbox")
    .select(({ fn }) => fn.countAll().as("n"))
    .where("delivery_state", "=", "pending")
    .executeTakeFirstOrThrow();
  for (let i = 0; i < Number(queuedCount.n) + 10; i++) {
    if (!(await anotherInstance.deliverOne())) break;
    if (
      f.calls.some(
        (c) =>
          c.method === "sendMessage" &&
          String(c.body.text).toLowerCase().includes("заявка принята"),
      )
    )
      break;
  }
  assert.ok(
    f.calls.some(
      (c) =>
        c.method === "sendMessage" &&
        String(c.body.text).toLowerCase().includes("заявка принята"),
    ),
  );
  assert.equal(
    (await f.solutions.list(f.owner.internalId, f.business.id))[0].status,
    "active",
  );
  await f.solutions.save(f.owner.internalId, f.business.id, {
    draft: readyDraft,
    revision: 1,
  });
  assert.equal(
    (await f.solutions.list(f.owner.internalId, f.business.id))[0].status,
    "active",
  );
  await f.send(7, "Спасибо");
  assert.equal(
    (await new LeadService(db).list(f.owner.internalId, f.business.id)).length,
    1,
  );
});

test("Telegram updates, answers, lead and queued confirmation roll back together", async () => {
  const f = await botFixture(["name"]);
  await f.send(9, "Оставить заявку");
  await f.send(10, "Анна");
  await sql`ALTER TABLE lead ADD CONSTRAINT reject_bot_test CHECK (source <> 'telegram') NOT VALID`.execute(
    db,
  );
  try {
    await assert.rejects(f.send(11, "Отправить"));
  } finally {
    await sql`ALTER TABLE lead DROP CONSTRAINT reject_bot_test`.execute(db);
  }
  assert.equal(
    (
      await db
        .selectFrom("telegram_update")
        .selectAll()
        .where("connection_id", "=", f.connection.id)
        .where("update_id", "=", "11")
        .execute()
    ).length,
    0,
  );
  await f.send(11, "Отправить");
  assert.equal(
    (await new LeadService(db).list(f.owner.internalId, f.business.id)).length,
    1,
  );
});

test("Telegram outbox retries without re-creating leads and preserves per-chat order", async () => {
  const f = await botFixture(["name"]);
  await f.send(20, "Оставить заявку");
  await f.send(21, "Анна");
  await f.send(22, "Отправить");
  // Drain other test fixtures so the worker selects this connection.
  await db
    .updateTable("telegram_outbox")
    .set({ delivered_at: new Date() })
    .where("connection_id", "!=", f.connection.id)
    .execute();
  const failing = new TelegramService(
    db,
    secret,
    "https://sreda.test",
    true,
    async () =>
      Response.json(
        { ok: false, parameters: { retry_after: 30 } },
        { status: 429 },
      ),
  );
  await failing.deliverOne();
  const first = await db
    .selectFrom("telegram_outbox")
    .selectAll()
    .where("connection_id", "=", f.connection.id)
    .orderBy("id")
    .execute();
  assert.equal(first[0].attempts, 1);
  assert.equal(first[1].attempts, 0);
  assert.equal(await failing.deliverOne(), false);
  await db
    .updateTable("telegram_outbox")
    .set({ available_at: new Date(0) })
    .where("id", "=", first[0].id)
    .execute();
  await f.telegram.deliverOne();
  await f.telegram.deliverOne();
  await f.telegram.deliverOne();
  assert.equal(
    (await new LeadService(db).list(f.owner.internalId, f.business.id)).length,
    1,
  );
  assert.equal(
    (
      await db
        .selectFrom("telegram_outbox")
        .selectAll()
        .where("connection_id", "=", f.connection.id)
        .where("delivered_at", "is", null)
        .execute()
    ).length,
    0,
  );
});

test("a blocked Telegram recipient cannot pause other chats or delete accepted leads", async () => {
  const f = await botFixture(["name"]);
  await f.send(78, "Оставить заявку", 123);
  await f.send(79, "Анна", 123);
  await f.send(80, "Отправить", 123);
  await f.send(82, "/start", 456);
  await db
    .updateTable("telegram_outbox")
    .set({ delivered_at: new Date() })
    .where("connection_id", "!=", f.connection.id)
    .execute();
  const worker = new TelegramService(
    db,
    secret,
    "https://sreda.test",
    true,
    async (url, init) => {
      if (JSON.parse(init.body).chat_id === "123")
        return Response.json({ ok: false }, { status: 403 });
      return f.transport(url, init);
    },
  );
  await worker.deliverOne();
  assert.equal(
    (await f.solutions.list(f.owner.internalId, f.business.id))[0].status,
    "active",
  );
  const pending = await db
    .selectFrom("telegram_outbox")
    .selectAll()
    .where("connection_id", "=", f.connection.id)
    .where("delivered_at", "is", null)
    .execute();
  assert.deepEqual(
    pending.map((row) => row.chat_id),
    ["456"],
  );
  assert.equal(
    (await new LeadService(db).list(f.owner.internalId, f.business.id)).length,
    1,
  );
  assert.equal(await worker.deliverOne(), true);
  assert.equal(f.calls.at(-1).body.chat_id, "456");
  await f.send(83, "Оставить заявку", 456);
  await f.send(84, "Борис", 456);
  await f.send(85, "Отправить", 456);
  assert.equal(
    (await new LeadService(db).list(f.owner.internalId, f.business.id)).length,
    2,
  );
  await f.send(86, "/start", 123);
  for (let i = 0; i < 10; i++) {
    if (!(await worker.deliverOne())) break;
  }
  assert.equal(
    (
      await db
        .selectFrom("telegram_dialog")
        .selectAll()
        .where("connection_id", "=", f.connection.id)
        .where("chat_id", "=", "123")
        .execute()
    ).length,
    0,
  );
});

test("Telegram disconnect cancels queued messages and rejects old webhook secrets", async () => {
  const f = await botFixture();
  await f.send(30, "/start");
  await f.connections.disconnect(f.owner.internalId, f.business.id, "telegram");
  await assert.rejects(f.send(31, "Анна"), { status: 403 });
  assert.equal(
    (
      await db
        .selectFrom("telegram_outbox")
        .selectAll()
        .where("connection_id", "=", f.connection.id)
        .execute()
    ).length,
    0,
  );
  assert.equal(
    (await f.solutions.list(f.owner.internalId, f.business.id))[0].status,
    "setup_required",
  );
});

test(
  "parallel Telegram delivery creates only one lead on PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL && "Requires PostgreSQL connections" },
  async () => {
    const f = await botFixture(["name"]);
    await f.send(39, "Оставить заявку");
    await f.send(40, "Анна");
    await Promise.all([f.send(41, "Отправить"), f.send(41, "Отправить")]);
    assert.equal(
      (await new LeadService(db).list(f.owner.internalId, f.business.id))
        .length,
      1,
    );
  },
);

test("permanent Telegram failure and stale worker cannot show an active solution", async () => {
  const f = await botFixture(["name"]);
  await f.send(50, "/start");
  await db
    .updateTable("telegram_outbox")
    .set({ delivered_at: new Date() })
    .where("connection_id", "!=", f.connection.id)
    .execute();
  const failed = new TelegramService(
    db,
    secret,
    "https://sreda.test",
    true,
    async () => Response.json({ ok: false }, { status: 401 }),
  );
  await failed.deliverOne();
  assert.equal(
    (await f.solutions.list(f.owner.internalId, f.business.id))[0].status,
    "paused",
  );
  await assert.rejects(f.send(51, "Анна"), { status: 503 });
  await f.telegram.start(f.owner.internalId, f.business.id);
  await db
    .updateTable("worker_heartbeat")
    .set({ seen_at: new Date(0) })
    .where("name", "=", "telegram")
    .execute();
  assert.equal(
    (await f.solutions.list(f.owner.internalId, f.business.id))[0].status,
    "paused",
  );
});

test("uncertain webhook reconfiguration removes a previous ready state", async () => {
  const f = await botFixture();
  const failed = new TelegramService(
    db,
    secret,
    "https://sreda.test",
    true,
    async () => {
      throw new Error("simulated timeout");
    },
  );
  await assert.rejects(failed.start(f.owner.internalId, f.business.id), {
    status: 503,
  });
  const runtime = await db
    .selectFrom("telegram_runtime")
    .select("status")
    .where("connection_id", "=", f.connection.id)
    .executeTakeFirstOrThrow();
  assert.equal(runtime.status, "error");
});

test("Telegram ignores group messages and cancel clears the pending dialogue", async () => {
  const f = await botFixture();
  await f.telegram.receive(f.connection.id, f.header, {
    update_id: 60,
    message: {
      text: "/start",
      chat: { id: -123, type: "group" },
      from: { id: 123 },
    },
  });
  assert.equal(
    (
      await db
        .selectFrom("telegram_dialog")
        .selectAll()
        .where("connection_id", "=", f.connection.id)
        .execute()
    ).length,
    0,
  );
  await f.send(61, "/start");
  await f.send(62, "/cancel");
  assert.equal(
    (
      await db
        .selectFrom("telegram_dialog")
        .selectAll()
        .where("connection_id", "=", f.connection.id)
        .execute()
    )[0].mode,
    "menu",
  );
  const messages = await db
    .selectFrom("telegram_outbox")
    .select("message")
    .where("connection_id", "=", f.connection.id)
    .where("delivered_at", "is", null)
    .execute();
  assert.equal(messages.length, 2);
  assert.match(messages[1].message, /отменено/);
});

async function configurePin(a, body = {}) {
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: a.cookie }),
  });
  return pins.configure(a.internalId, session.session.id, {
    enabled: true,
    currentPassword: password,
    pin: "0826",
    pinConfirmation: "0826",
    ...body,
  });
}
const pinSignin = (a, pin, value = password) =>
  authHandler(
    request("/api/auth/sign-in/username", {
      method: "POST",
      body: { username: a.username, password: value, pin },
    }),
  );

test("PIN requires password and valid session, stores no plaintext, and scopes management to the caller", async () => {
  const a = await login();
  const b = await login();
  assert.equal((await pinHandler(request("/pin"))).status, 401);
  assert.equal(
    (
      await pinHandler(
        request("/pin", {
          method: "POST",
          cookie: a.cookie,
          headers: { origin: "https://evil.example" },
          body: {},
        }),
      )
    ).status,
    403,
  );
  await assert.rejects(
    configurePin(a, { currentPassword: "wrong-password-12345" }),
    { status: 400 },
  );
  await assert.rejects(configurePin(a, { pin: 826, pinConfirmation: 826 }), {
    status: 400,
  });
  await assert.rejects(configurePin(a, { pinConfirmation: "1111" }), {
    status: 400,
  });
  assert.equal(
    (
      await pinHandler(
        request("/pin", {
          method: "POST",
          cookie: a.cookie,
          body: {
            enabled: true,
            currentPassword: password,
            pin: "0826",
            pinConfirmation: "0826",
            userId: b.internalId,
          },
        }),
      )
    ).status,
    200,
  );
  assert.deepEqual(
    await (await pinHandler(request("/pin", { cookie: a.cookie }))).json(),
    { enabled: true },
  );
  assert.deepEqual(await pins.status(b.internalId), { enabled: false });
  const row = await db
    .selectFrom("account_pin")
    .selectAll()
    .where("user_id", "=", a.internalId)
    .executeTakeFirstOrThrow();
  assert.notEqual(row.pin_hash, "0826");
  assert.equal(
    await verifyPassword({ hash: row.pin_hash, password: "0826" }),
    false,
  );
  await assert.rejects(
    configurePin(a, { enabled: false, currentPin: "1111" }),
    { status: 400 },
  );
});

test("PIN gates every new login, revokes other sessions and preserves unrelated accounts", async () => {
  const a = await login();
  const b = await login();
  const existing = await signin(a.username);
  const oldCookie = existing.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  await configurePin(a);
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: oldCookie }))).status,
    401,
  );
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: a.cookie }))).status,
    200,
  );
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: b.cookie }))).status,
    200,
  );
  for (const pin of [undefined, "1111", "826"]) {
    const result = await pinSignin(a, pin);
    assert.equal(result.status, 400);
    assert.deepEqual(result.headers.getSetCookie(), []);
    assert.equal((await result.json()).error.code, "PIN_REQUIRED");
  }
  assert.equal(
    (
      await db
        .selectFrom("session")
        .select("id")
        .where("userId", "=", a.internalId)
        .execute()
    ).length,
    1,
  );
  const wrongPassword = await pinSignin(a, "0826", "wrong-password-1234");
  assert.equal((await wrongPassword.json()).error.code, "AUTH_FAILED");
  assert.equal((await pinSignin(a, "0826")).status, 200);
  await configurePin(a, {
    currentPin: "0826",
    pin: "6723",
    pinConfirmation: "6723",
  });
  assert.equal((await pinSignin(a, "0826")).status, 400);
  assert.equal((await pinSignin(a, "6723")).status, 200);
  await configurePin(a, { enabled: false, currentPin: "6723" });
  assert.equal((await signin(a.username)).status, 200);
});

test("five failed PIN attempts lock across instances; expiry and a correct PIN reset the counter", async () => {
  const a = await login();
  await configurePin(a);
  for (let i = 0; i < 5; i++)
    assert.equal((await pinSignin(a, "1111")).status, i === 4 ? 429 : 400);
  const anotherHandler = createAuthHandler({
    db,
    auth: createIdentity({ db, origin, secret }),
    origin,
    secret,
  });
  const blocked = await anotherHandler(
    request("/api/auth/sign-in/username", {
      method: "POST",
      body: { username: a.username, password, pin: "0826" },
    }),
  );
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, "PIN_LOCKED");
  assert.deepEqual(blocked.headers.getSetCookie(), []);
  assert.equal(
    (
      await db
        .selectFrom("session")
        .select("id")
        .where("userId", "=", a.internalId)
        .execute()
    ).length,
    1,
  );
  await db
    .updateTable("account_pin")
    .set({ locked_until: new Date(0) })
    .where("user_id", "=", a.internalId)
    .execute();
  assert.equal((await pinSignin(a, "0826")).status, 200);
  const row = await db
    .selectFrom("account_pin")
    .selectAll()
    .where("user_id", "=", a.internalId)
    .executeTakeFirstOrThrow();
  assert.equal(row.failed_attempts, 0);
  assert.equal(row.locked_until, null);
});

test("PIN recovery is atomic, revokes sessions and allows password login after reset", async () => {
  const a = await login();
  const { codes } = await recovery.issue(a.internalId, password);
  await configurePin(a);
  const next = "pin-recovery-password-12345";
  await sql`ALTER TABLE account_security_event ADD CONSTRAINT reject_pin_reset CHECK (action <> 'password_recovered') NOT VALID`.execute(
    db,
  );
  try {
    await assert.rejects(
      recovery.recover({
        username: a.username,
        recoveryCode: codes[0],
        newPassword: next,
        passwordConfirmation: next,
      }),
    );
    assert.deepEqual(await pins.status(a.internalId), { enabled: true });
    assert.equal(
      (await app.me(request("/api/v1/me", { cookie: a.cookie }))).status,
      200,
    );
  } finally {
    await sql`ALTER TABLE account_security_event DROP CONSTRAINT reject_pin_reset`.execute(
      db,
    );
  }
  await recovery.recover({
    username: a.username,
    recoveryCode: codes[0],
    newPassword: next,
    passwordConfirmation: next,
  });
  assert.deepEqual(await pins.status(a.internalId), { enabled: false });
  assert.equal(
    (await app.me(request("/api/v1/me", { cookie: a.cookie }))).status,
    401,
  );
  assert.equal((await signin(a.username, next)).status, 200);
});

for (const operation of ["enable", "change", "disable"]) {
  test(
    `in-flight login cannot survive PIN ${operation}`,
    { timeout: 20000 },
    async () => {
      const a = await login();
      if (operation !== "enable") await configurePin(a);
      const verified = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const delayedAuth = createBarrierAuth(async (input) => {
        const valid = await verifyPassword(input);
        verified.resolve();
        await resume.promise;
        return valid;
      });
      const handler = createAuthHandler({
        db,
        auth: delayedAuth,
        origin,
        secret,
      });
      const pending = handler(
        request("/api/auth/sign-in/username", {
          method: "POST",
          body: {
            username: a.username,
            password,
            ...(operation !== "enable" ? { pin: "0826" } : {}),
          },
        }),
      );
      try {
        await Promise.race([
          verified.promise,
          pending.then(async (early) => {
            const detail = await early
              .clone()
              .text()
              .catch(() => "");
            throw new Error(
              `Login finished before barrier: HTTP ${early.status} ${detail}`,
            );
          }),
        ]);
        await configurePin(
          a,
          operation === "disable"
            ? { enabled: false, currentPin: "0826" }
            : operation === "change"
              ? { currentPin: "0826", pin: "6723", pinConfirmation: "6723" }
              : {},
        );
      } finally {
        resume.resolve();
      }
      const result = await pending;
      assert.equal(result.status, 400);
      assert.equal((await result.json()).error.code, "AUTH_FAILED");
      assert.deepEqual(result.headers.getSetCookie(), []);
      assert.equal(
        (
          await db
            .selectFrom("session")
            .select("id")
            .where("userId", "=", a.internalId)
            .execute()
        ).length,
        1,
      );
    },
  );
}

test(
  "in-flight login cannot survive PIN disable at the credential guard",
  async () => {
    const a = await login();
    await configurePin(a);
    const beforeSignin = new Set(
      (await db
        .selectFrom("session")
        .select("id")
        .where("userId", "=", a.internalId)
        .execute())
        .map((row) => row.id),
    );
    const established = await pinSignin(a, "0826");
    assert.equal(established.status, 200);
    const issued = (
      await db
        .selectFrom("session")
        .select(["id", "token"])
        .where("userId", "=", a.internalId)
        .execute()
    ).filter((row) => !beforeSignin.has(row.id));
    assert.equal(issued.length, 1);
    const inFlight = issued[0];
    const before = await loginCredential(db, a.username);
    assert.ok(before?.pin_hash, "snapshot captured the PIN hash");
    // Control: the snapshot and the freshly issued session are accepted while
    // the PIN state still matches the snapshot.
    assert.equal(
      await acceptLogin(db, before, inFlight.token, secret, "0826"),
      "accepted",
    );
    assert.equal(
      (
        await db
          .selectFrom("session")
          .select("id")
          .where("token", "=", inFlight.token)
          .execute()
      ).length,
      1,
      "the accepted session survives the control check",
    );
    // The concurrent request invalidates the PIN state between password
    // verification and acceptLogin: the stale snapshot must be rejected and
    // the session the in-flight login would release must be destroyed.
    await pins.configure(a.internalId, inFlight.id, {
      enabled: false,
      currentPassword: password,
      currentPin: "0826",
    });
    assert.equal(
      await acceptLogin(db, before, inFlight.token, secret, "0826"),
      "credentials",
    );
    assert.equal(
      (
        await db
          .selectFrom("session")
          .select("id")
          .where("token", "=", inFlight.token)
          .execute()
      ).length,
      0,
      "the in-flight session is destroyed",
    );
    assert.deepEqual(await pins.status(a.internalId), { enabled: false });
  },
);

test(
  "concurrent wrong PIN requests enforce one shared five-attempt lock on PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL && "Requires PostgreSQL connections" },
  async () => {
    const a = await login();
    await configurePin(a);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => pinSignin(a, "1111")),
    );
    assert.equal(results.filter((r) => r.status === 400).length, 4);
    assert.equal(results.filter((r) => r.status === 429).length, 2);
    const row = await db
      .selectFrom("account_pin")
      .selectAll()
      .where("user_id", "=", a.internalId)
      .executeTakeFirstOrThrow();
    assert.equal(row.failed_attempts, 5);
    assert.ok(row.locked_until > new Date());
    assert.equal(
      (
        await db
          .selectFrom("session")
          .select("id")
          .where("userId", "=", a.internalId)
          .execute()
      ).length,
      1,
    );
  },
);

test("uncertain Telegram delivery is not blindly retried after a timeout", async () => {
  const f = await botFixture();
  await f.send(901, "/start");
  await db
    .updateTable("telegram_outbox")
    .set({ delivered_at: new Date(), delivery_state: "sent" })
    .where("connection_id", "!=", f.connection.id)
    .execute();
  let calls = 0;
  const worker = new TelegramService(
    db,
    secret,
    "https://sreda.test",
    true,
    async () => {
      calls++;
      throw new Error("response lost after acceptance");
    },
  );
  await worker.deliverOne();
  await worker.deliverOne();
  assert.equal(calls, 1);
  assert.equal(
    (
      await db
        .selectFrom("telegram_outbox")
        .select("delivery_state")
        .where("connection_id", "=", f.connection.id)
        .executeTakeFirstOrThrow()
    ).delivery_state,
    "uncertain",
  );
});
test("accepted Telegram send with database failure retains committed claim across restart", async () => {
  const f = await botFixture();
  await f.send(902, "/start");
  await db
    .updateTable("telegram_outbox")
    .set({ delivered_at: new Date(), delivery_state: "sent" })
    .where("connection_id", "!=", f.connection.id)
    .execute();
  let calls = 0;
  const worker = new TelegramService(
    db,
    secret,
    "https://sreda.test",
    true,
    async () => {
      calls++;
      return Response.json({ ok: true, result: { message_id: 100 } });
    },
  );
  await sql`ALTER TABLE telegram_outbox ADD CONSTRAINT reject_delivery_test CHECK (delivery_state <> 'sent') NOT VALID`.execute(
    db,
  );
  try {
    await assert.rejects(worker.deliverOne());
  } finally {
    await sql`ALTER TABLE telegram_outbox DROP CONSTRAINT reject_delivery_test`.execute(
      db,
    );
  }
  await db
    .updateTable("telegram_outbox")
    .set({ claimed_at: new Date(0) })
    .where("connection_id", "=", f.connection.id)
    .execute();
  await worker.deliverOne();
  assert.equal(calls, 1);
  assert.equal(
    (
      await db
        .selectFrom("telegram_outbox")
        .select("delivery_state")
        .where("connection_id", "=", f.connection.id)
        .executeTakeFirstOrThrow()
    ).delivery_state,
    "uncertain",
  );
});
test(
  "only one employee can claim a conversation concurrently on PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL && "Requires PostgreSQL connections" },
  async () => {
    const { CommunicationService } = await import(
      "../src/server/communications/service.ts"
    );
    const owner = await login(),
      operator = await login();
    const business = await (await create(owner)).json();
    const invite = await invitations.create(
      owner.internalId,
      business.id,
      operator.user.id,
      "operator",
    );
    await invitations.accept(operator.internalId, invite.id);
    const internal = await db
      .selectFrom("business")
      .select("id")
      .where("public_id", "=", business.id)
      .executeTakeFirstOrThrow();
    const cs = new CommunicationService(db);
    const conversation = await cs.recordInbound({
      businessId: internal.id,
      platform: "telegram",
      externalUserId: "777",
      text: "Вопрос",
    });
    const results = await Promise.allSettled([
      cs.updateStatus(
        owner.internalId,
        business.id,
        conversation.conversationId,
        { status: "assigned" },
      ),
      cs.updateStatus(
        operator.internalId,
        business.id,
        conversation.conversationId,
        { status: "assigned" },
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.code,
      "CONVERSATION_ASSIGNED",
    );
  },
);
