const PBKDF2_ITERATIONS = 100_000;
const ENCRYPTED_MARKER = '"budgetEncV1"';

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

function b64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncryptedFile(content: string): boolean {
  return content.trimStart().includes(ENCRYPTED_MARKER);
}

export async function encryptData(plaintext: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return JSON.stringify({
    budgetEncV1: 1,
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    data: bufToB64(ciphertext),
  });
}

/** Throws if password is wrong (AES-GCM authentication will fail). */
export async function decryptData(encryptedJson: string, password: string): Promise<string> {
  const { budgetEncV1, salt: saltB64, iv: ivB64, data: dataB64 } = JSON.parse(encryptedJson);
  if (budgetEncV1 !== 1) throw new Error('Unsupported encryption version');
  const key = await deriveKey(password, b64ToBuf(saltB64));
  let decrypted: ArrayBuffer;
  try {
    const ivBuf = b64ToBuf(ivB64);
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBuf.buffer as ArrayBuffer },
      key,
      b64ToBuf(dataB64).buffer as ArrayBuffer,
    );
  } catch {
    throw new Error('Wrong password or corrupted file');
  }
  return new TextDecoder().decode(decrypted);
}
