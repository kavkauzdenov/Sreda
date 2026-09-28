import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
} from "../src/server/connections/crypto.ts";

function legacyV1(value, secret) {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return `v1.${iv.toString("base64url")}.${cipher
    .getAuthTag()
    .toString("base64url")}.${encrypted.toString("base64url")}`;
}

test("new connection secrets use versioned v2 encryption", () => {
  const previous = process.env.CONNECTION_ENCRYPTION_KEY;
  process.env.CONNECTION_ENCRYPTION_KEY =
    "connection-key-test-" + "x".repeat(40);
  try {
    const token = "telegram-token-sensitive-123";
    const legacySecret = "legacy-server-secret-value-at-least-32-characters";
    const encrypted = encryptSecret(token, legacySecret);
    assert.notEqual(encrypted, token);
    assert.ok(encrypted.startsWith("v2."));
    assert.equal(decryptSecret(encrypted, legacySecret), token);
  } finally {
    if (previous === undefined) delete process.env.CONNECTION_ENCRYPTION_KEY;
    else process.env.CONNECTION_ENCRYPTION_KEY = previous;
  }
});

test("legacy v1 connection secrets remain readable after key split", () => {
  const legacySecret = "legacy-server-secret-value-at-least-32-characters";
  const token = "legacy-token-sensitive-123";
  const encrypted = legacyV1(token, legacySecret);
  const previous = process.env.CONNECTION_ENCRYPTION_KEY;
  process.env.CONNECTION_ENCRYPTION_KEY =
    "new-connection-key-" + "y".repeat(40);
  try {
    assert.equal(decryptSecret(encrypted, legacySecret), token);
  } finally {
    if (previous === undefined) delete process.env.CONNECTION_ENCRYPTION_KEY;
    else process.env.CONNECTION_ENCRYPTION_KEY = previous;
  }
});

test("v2 secrets support planned previous-key rotation", () => {
  const legacySecret = "legacy-server-secret-value-at-least-32-characters";
  const oldKey = "old-connection-key-" + "a".repeat(40);
  const newKey = "new-connection-key-" + "b".repeat(40);
  const previousPrimary = process.env.CONNECTION_ENCRYPTION_KEY;
  const previousKeys = process.env.CONNECTION_ENCRYPTION_PREVIOUS_KEYS;

  process.env.CONNECTION_ENCRYPTION_KEY = oldKey;
  const encrypted = encryptSecret("rotated-token", legacySecret);

  process.env.CONNECTION_ENCRYPTION_KEY = newKey;
  process.env.CONNECTION_ENCRYPTION_PREVIOUS_KEYS = oldKey;
  try {
    assert.equal(decryptSecret(encrypted, legacySecret), "rotated-token");
  } finally {
    if (previousPrimary === undefined)
      delete process.env.CONNECTION_ENCRYPTION_KEY;
    else process.env.CONNECTION_ENCRYPTION_KEY = previousPrimary;
    if (previousKeys === undefined)
      delete process.env.CONNECTION_ENCRYPTION_PREVIOUS_KEYS;
    else process.env.CONNECTION_ENCRYPTION_PREVIOUS_KEYS = previousKeys;
  }
});
