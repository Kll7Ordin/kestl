const LEGACY_ITERATIONS = 100_000;
export const CURRENT_ITERATIONS = 600_000;
const ENCRYPTED_MARKER = '"budgetEncV1"';

export interface SessionKey {
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
}

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncryptedFile(content: string): boolean {
  return content.trimStart().includes(ENCRYPTED_MARKER);
}

export async function createSessionKey(
  password: string,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
  iterations: number = CURRENT_ITERATIONS,
): Promise<SessionKey> {
  return { key: await deriveKey(password, salt, iterations), salt, iterations };
}

/** Encrypts with a cached key and a fresh random 96-bit IV; writes a v2 envelope. */
export async function encryptWithKey(plaintext: string, sk: SessionKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sk.key, new TextEncoder().encode(plaintext));
  return JSON.stringify({
    budgetEncV1: 2,
    kdf: 'PBKDF2-SHA256',
    iterations: sk.iterations,
    salt: bufToB64(sk.salt),
    iv: bufToB64(iv),
    data: bufToB64(ciphertext),
  });
}

/**
 * Decrypts a v1 or v2 envelope. Throws if the password is wrong.
 * For v1 files a new v2 SessionKey is returned and needsUpgrade is true, so the caller can re-save once.
 */
export async function decryptWithPassword(
  encryptedJson: string,
  password: string,
): Promise<{ plaintext: string; sessionKey: SessionKey; needsUpgrade: boolean }> {
  const env = JSON.parse(encryptedJson);
  const version = env.budgetEncV1;
  if (version !== 1 && version !== 2) throw new Error('Unsupported encryption version');
  const iterations: number = version === 1 ? LEGACY_ITERATIONS : Number(env.iterations);
  if (!Number.isFinite(iterations) || iterations < 1) throw new Error('Unsupported encryption parameters');
  const salt = b64ToBuf(env.salt);
  const key = await deriveKey(password, salt, iterations);
  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(env.iv).buffer as ArrayBuffer },
      key,
      b64ToBuf(env.data).buffer as ArrayBuffer,
    );
  } catch {
    throw new Error('Wrong password or corrupted file');
  }
  const plaintext = new TextDecoder().decode(decrypted);
  if (version === 1) {
    return { plaintext, sessionKey: await createSessionKey(password), needsUpgrade: true };
  }
  return { plaintext, sessionKey: { key, salt, iterations }, needsUpgrade: false };
}

export async function encryptData(plaintext: string, password: string): Promise<string> {
  return encryptWithKey(plaintext, await createSessionKey(password));
}

/** Throws if password is wrong (AES-GCM authentication will fail). */
export async function decryptData(encryptedJson: string, password: string): Promise<string> {
  return (await decryptWithPassword(encryptedJson, password)).plaintext;
}
