import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from '@awbs/db';
import { inEpoch } from './transaction.ts';

const derive = promisify(scrypt);
export const randomToken = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

async function credentialWrite<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const state = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0];
  assert(state, '시스템 초기값이 필요합니다.');
  return inEpoch(pool, state.epoch, fn);
}

export async function hashPassword(password: string): Promise<string> {
  if ([...password].length < 12 || Buffer.byteLength(password) > 1024) throw new Error('비밀번호는 최소 12글자, 최대 1024바이트여야 합니다.');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hex] = stored.split(':');
  if (kind !== 'scrypt' || !salt || !hex || !/^[a-f0-9]{128}$/.test(hex) || Buffer.byteLength(password) > 1024) return false;
  const actual = await derive(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}

export async function issueLoginLink(pool: Pool): Promise<string> {
  const token = randomToken();
  await credentialWrite(pool, (client) => client.query("insert into lead_login_tokens(token_hash,expires_at) values($1,now()+interval '5 minutes')", [tokenHash(token)]));
  return token;
}

export async function setPassword(pool: Pool, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await credentialWrite(pool, async (client) => {
    await client.query('insert into lead_credentials(password_hash) values($1) on conflict(singleton) do update set password_hash=excluded.password_hash', [hash]);
    await client.query("delete from lead_sessions where csrf like 'password.%'");
  });
}

export async function issueRunnerToken(pool: Pool, runnerId: string, publicKey: string): Promise<string> {
  if (!runnerId.trim() || !publicKey.trim()) throw new Error('Runner ID와 공개키가 필요합니다.');
  const token = randomToken();
  await credentialWrite(pool, (client) => client.query('insert into runner_tokens(token_hash,runner_id,public_key) values($1,$2,$3)', [tokenHash(token), runnerId, publicKey]));
  return token;
}

export async function revokeRunnerToken(pool: Pool, token: string): Promise<void> {
  await credentialWrite(pool, (client) => client.query('update runner_tokens set revoked_at=now() where token_hash=$1 and revoked_at is null', [tokenHash(token)]));
}
