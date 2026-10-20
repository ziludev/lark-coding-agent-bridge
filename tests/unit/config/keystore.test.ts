import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearKeystoreDerivedKeyCache,
  getSecret,
  setSecret,
  type KeystorePaths,
} from '../../../src/config/keystore';

const KEY_LEN = 32;
const IV_LEN = 12;
const PBKDF2_ITER = 100_000;

const dirs: string[] = [];

async function makeStore(): Promise<KeystorePaths> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-keystore-'));
  dirs.push(dir);
  return {
    secretsFile: join(dir, 'secrets.enc'),
    keystoreSaltFile: join(dir, '.keystore.salt'),
  };
}

afterEach(async () => {
  clearKeystoreDerivedKeyCache();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Write an envelope using the pre-fix scheme: pbkdf2(hostname|username, salt). */
async function writeLegacySecret(
  store: KeystorePaths,
  id: string,
  plaintext: string,
): Promise<void> {
  const salt = randomBytes(KEY_LEN);
  await writeFile(store.keystoreSaltFile, salt, { mode: 0o600 });
  const key = pbkdf2Sync(
    `${hostname()}|${userInfo().username}`,
    salt,
    PBKDF2_ITER,
    KEY_LEN,
    'sha256',
  );
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  await writeFile(
    store.secretsFile,
    JSON.stringify({
      version: 1,
      entries: {
        [id]: {
          iv: iv.toString('base64'),
          data: data.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
        },
      },
    }),
    { mode: 0o600 },
  );
}

describe('keystore key derivation', () => {
  it('round-trips a secret under the hostname-free key', async () => {
    const store = await makeStore();
    await setSecret('app-cli_x', 'super-secret', store);
    clearKeystoreDerivedKeyCache();

    expect(await getSecret('app-cli_x', store)).toBe('super-secret');
  });

  it('reads a legacy hostname-derived entry and re-encrypts it', async () => {
    const store = await makeStore();
    await writeLegacySecret(store, 'app-cli_legacy', 'legacy-secret');

    // First read goes through the legacy seed...
    expect(await getSecret('app-cli_legacy', store)).toBe('legacy-secret');

    // ...and rewrites the entry, so it no longer depends on the hostname.
    const rewritten = JSON.parse(await readFile(store.secretsFile, 'utf8'));
    expect(rewritten.entries['app-cli_legacy']).toBeDefined();
    clearKeystoreDerivedKeyCache();
    expect(await getSecret('app-cli_legacy', store)).toBe('legacy-secret');

    // The rewritten envelope is byte-different from the legacy one (new IV).
    const before = await readFile(store.secretsFile, 'utf8');
    await setSecret('app-cli_legacy', 'legacy-secret', store);
    expect(await readFile(store.secretsFile, 'utf8')).not.toBe(before);
  });

  it('surfaces a real corruption instead of silently returning empty', async () => {
    const store = await makeStore();
    await writeLegacySecret(store, 'app-cli_broken', 'value');
    const parsed = JSON.parse(await readFile(store.secretsFile, 'utf8'));
    // Break the auth tag: neither the current nor the legacy key can verify it.
    parsed.entries['app-cli_broken'].tag = Buffer.alloc(16, 7).toString('base64');
    await writeFile(store.secretsFile, JSON.stringify(parsed), { mode: 0o600 });

    await expect(getSecret('app-cli_broken', store)).rejects.toThrow();
  });
});
