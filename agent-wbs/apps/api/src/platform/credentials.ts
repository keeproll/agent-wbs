import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from '@awbs/db';
import { inEpoch } from './transaction.ts';

export const randomToken = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

async function credentialWrite<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const state = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0];
  assert(state, '시스템 초기값이 필요합니다.');
  return inEpoch(pool, state.epoch, fn);
}

export async function issueLoginLink(pool: Pool): Promise<string> {
  const token = randomToken();
  await credentialWrite(pool, (client) => client.query("insert into lead_login_tokens(token_hash,expires_at) values($1,now()+interval '5 minutes')", [tokenHash(token)]));
  return token;
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
