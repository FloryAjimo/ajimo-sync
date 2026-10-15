const ENVELOPE_VERSION = 1;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importAesKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyBase64);
  if (raw.byteLength !== KEY_LENGTH) {
    throw new Error("Vault key must be exactly 32 bytes (AES-256).");
  }
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export function generateVaultKeyBase64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  return bytesToBase64(raw);
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encryptEnvelope(
  plaintext: ArrayBuffer | Uint8Array,
  keyBase64: string,
  purpose: "object" | "manifest"
): Promise<ArrayBuffer> {
  const key = await importAesKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plainBytes = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  const aad = encoder.encode(`private-sync/${purpose}/v1`);

  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: toArrayBuffer(iv),
    additionalData: toArrayBuffer(aad),
    tagLength: 128
  }, key, toArrayBuffer(plainBytes)));

  const envelope = new Uint8Array(1 + IV_LENGTH + ciphertext.byteLength);
  envelope[0] = ENVELOPE_VERSION;
  envelope.set(iv, 1);
  envelope.set(ciphertext, 1 + IV_LENGTH);
  return envelope.buffer;
}

export async function decryptEnvelope(
  envelope: ArrayBuffer | Uint8Array,
  keyBase64: string,
  purpose: "object" | "manifest"
): Promise<ArrayBuffer> {
  const bytes = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
  if (bytes.byteLength < 1 + IV_LENGTH + 16) {
    throw new Error("Encrypted payload is too short.");
  }
  if (bytes[0] !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted payload version: ${bytes[0]}.`);
  }

  const key = await importAesKey(keyBase64);
  const iv = bytes.slice(1, 1 + IV_LENGTH);
  const ciphertext = bytes.slice(1 + IV_LENGTH);
  const aad = encoder.encode(`private-sync/${purpose}/v1`);

  return crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: toArrayBuffer(iv),
    additionalData: toArrayBuffer(aad),
    tagLength: 128
  }, key, toArrayBuffer(ciphertext));
}

export async function encryptJson(value: unknown, keyBase64: string): Promise<ArrayBuffer> {
  const bytes = encoder.encode(JSON.stringify(value));
  return encryptEnvelope(bytes, keyBase64, "manifest");
}

export async function decryptJson<T>(payload: ArrayBuffer, keyBase64: string): Promise<T> {
  const plain = await decryptEnvelope(payload, keyBase64, "manifest");
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
