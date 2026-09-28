import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

function digest(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function keyId(secret: string) {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

function encryptionKeyring(legacySecret: string) {
  const configured = process.env.CONNECTION_ENCRYPTION_KEY?.trim();
  if (configured && configured.length < 32)
    throw new Error("CONNECTION_ENCRYPTION_KEY must be at least 32 characters");
  const primary = configured || legacySecret;

  const previous = (process.env.CONNECTION_ENCRYPTION_PREVIOUS_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const values = [primary, ...previous, legacySecret];
  return [...new Set(values)];
}

function decryptWithSecret(
  iv: string,
  tag: string,
  data: string,
  secret: string,
) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    digest(secret),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptSecret(value: string, legacySecret: string) {
  const primary = encryptionKeyring(legacySecret)[0]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", digest(primary), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v2",
    keyId(primary),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptSecret(value: string, legacySecret: string) {
  const parts = value.split(".");
  const keyring = encryptionKeyring(legacySecret);

  if (parts[0] === "v2") {
    const [, expectedKeyId, iv, tag, data] = parts;
    if (!expectedKeyId || !iv || !tag || !data)
      throw new Error("Invalid secret");

    const candidates = keyring.filter(
      (secret) => keyId(secret) === expectedKeyId,
    );
    if (!candidates.length) throw new Error("Unknown encryption key");

    for (const secret of candidates) {
      try {
        return decryptWithSecret(iv!, tag!, data!, secret);
      } catch {
        // Try another key with the same id only in the extremely unlikely event
        // of a truncated-id collision.
      }
    }
    throw new Error("Invalid secret");
  }

  if (parts[0] === "v1") {
    const [, iv, tag, data] = parts;
    if (!iv || !tag || !data) throw new Error("Invalid secret");

    for (const secret of keyring) {
      try {
        return decryptWithSecret(iv!, tag!, data!, secret);
      } catch {
        // Legacy v1 had no key id, so rotation requires trying the keyring.
      }
    }
    throw new Error("Invalid secret");
  }

  throw new Error("Invalid secret");
}
