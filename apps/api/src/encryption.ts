import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function getMasterKey(): Buffer {
  const key = process.env.LLM_API_KEY_ENCRYPTION_KEY?.trim();
  if (!key) {
    throw new Error("LLM_API_KEY_ENCRYPTION_KEY environment variable is required");
  }
  if (key.length !== 64 || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error("LLM_API_KEY_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(key, "hex");
}

export function encryptApiKey(plaintext: string): string {
  const masterKey = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptApiKey(encrypted: string): string {
  const masterKey = getMasterKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted API key format");
  }
  const iv = Buffer.from(parts[0], "base64");
  const authTag = Buffer.from(parts[1], "base64");
  const ciphertext = Buffer.from(parts[2], "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function validateEncryptionKey(): void {
  // Throws if LLM_API_KEY_ENCRYPTION_KEY is missing or invalid. Used at server startup.
  getMasterKey();
}
