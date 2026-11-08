import { describe, it, expect } from 'vitest';
import { decryptWithPassword, encryptWithKey, createSessionKey, isEncryptedFile } from './crypto';

function b64(buf: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : buf)));
}

async function makeV1(plain: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return JSON.stringify({ budgetEncV1: 1, salt: b64(salt), iv: b64(iv), data: b64(ct) });
}

describe('crypto', () => {
  it('decrypts v1 envelope and requests upgrade', async () => {
    const env = await makeV1('hello', 'pw');
    expect(isEncryptedFile(env)).toBe(true);
    const r = await decryptWithPassword(env, 'pw');
    expect(r.plaintext).toBe('hello');
    expect(r.needsUpgrade).toBe(true);
    expect(r.sessionKey.iterations).toBe(600_000);
  });

  it('v2 round trip reusing one key', async () => {
    const sk = await createSessionKey('pw', undefined, 1000);
    const a = await encryptWithKey('one', sk);
    const b = await encryptWithKey('one', sk);
    expect(a).not.toBe(b); // fresh IV each time
    expect(JSON.parse(a).budgetEncV1).toBe(2);
    const r = await decryptWithPassword(a, 'pw');
    expect(r.plaintext).toBe('one');
    expect(r.needsUpgrade).toBe(false);
  });

  it('wrong password throws', async () => {
    const sk = await createSessionKey('pw', undefined, 1000);
    const a = await encryptWithKey('x', sk);
    await expect(decryptWithPassword(a, 'nope')).rejects.toThrow();
  });
});
