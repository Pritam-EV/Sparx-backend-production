// services/productionV3Secrets.js
// AES-256-GCM encryption for production Wi-Fi credentials.
// PRODUCTION_WIFI_ENCRYPTION_KEY must be a 32-byte base64 key or 64 hex chars.

const crypto = require("crypto");

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function getEncryptionKey() {
  const configured = String(
    process.env.PRODUCTION_WIFI_ENCRYPTION_KEY || ""
  ).trim();

  if (!configured) {
    throw new Error("PRODUCTION_WIFI_ENCRYPTION_KEY is not configured");
  }

  const key = /^[0-9a-fA-F]{64}$/.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64");

  if (key.length !== KEY_BYTES) {
    throw new Error(
      "PRODUCTION_WIFI_ENCRYPTION_KEY must decode to exactly 32 bytes"
    );
  }

  return key;
}

function encryptSecret(plainText) {
  if (typeof plainText !== "string") {
    throw new TypeError("Secret must be a string");
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptSecret(envelope) {
  if (typeof envelope !== "string" || !envelope) {
    throw new TypeError("Encrypted secret is required");
  }

  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unsupported encrypted secret format");
  }

  const [, ivPart, tagPart, encryptedPart] = parts;
  const iv = Buffer.from(ivPart, "base64");
  const authTag = Buffer.from(tagPart, "base64");
  const encrypted = Buffer.from(encryptedPart, "base64");

  if (iv.length !== IV_BYTES || authTag.length !== 16) {
    throw new Error("Invalid encrypted secret envelope");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = { encryptSecret, decryptSecret };
