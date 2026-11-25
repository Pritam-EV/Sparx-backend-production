const crypto = require("crypto");

const VERSION = "v1";

function getEncryptionKey() {
  const value =
    process.env.PRODUCTION_V3_ENCRYPTION_KEY || "";

  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(
      "PRODUCTION_V3_ENCRYPTION_KEY must be exactly 64 hexadecimal characters."
    );
  }

  return Buffer.from(value, "hex");
}

function encryptSecret(value) {
  if (typeof value !== "string") {
    throw new Error("Secret must be a string.");
  }

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

function decryptSecret(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Encrypted secret is missing.");
  }

  const parts = value.split(".");

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unsupported encrypted secret format.");
  }

  const [, ivText, tagText, encryptedText] = parts;

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivText, "base64")
  );

  decipher.setAuthTag(
    Buffer.from(tagText, "base64")
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(encryptedText, "base64")
    ),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = {
  encryptSecret,
  decryptSecret,
};