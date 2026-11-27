/**
 * SMTP 비밀번호 보관(G§9.6-6 7 L1051, data-model `mail_settings`: 비밀값은 secrets).
 *
 * - AES-256-GCM(암호화 방식의 하나)으로 암호화해 `secrets` 표에 넣는다. 키는 서버 환경 변수 `AWBS_SECRET_KEY`다.
 *   GitHub 토큰 저장(settings/service.ts putGithub)과 같은 형식이다: ciphertext = 암호문+인증 태그(base64), nonce = 12바이트(base64).
 * - 비밀번호는 쓰기 전용이다. API 응답·로그·내보내기에는 `pwSet`(등록 여부)만 나간다.
 * - 보낼 때만 worker가 꺼내 SMTP 로그인에 쓴다.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { PoolClient } from '@awbs/db';
import { ApiError } from '../changes/http.ts';

export const SMTP_SECRET = 'smtp-password';

function key(): Buffer {
  const hex = process.env.AWBS_SECRET_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new ApiError('UNAVAILABLE', {}, [], '비밀값 저장 키가 없습니다. AWBS_SECRET_KEY에 32바이트의 16진수 값을 설정하세요.');
  return Buffer.from(hex, 'hex');
}

export async function storeSmtpPassword(client: PoolClient, password: string): Promise<void> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  await client.query(`insert into secrets(key,ciphertext,nonce,key_version,last4) values($1,$2,$3,1,'')
    on conflict(key) do update set ciphertext=excluded.ciphertext,nonce=excluded.nonce,key_version=excluded.key_version,last4=excluded.last4`,
  [SMTP_SECRET, encrypted.toString('base64'), nonce.toString('base64')]);
}

/** 저장한 비밀번호. 없으면 null. 키가 바뀌어 풀 수 없으면 오류를 던진다. */
export async function readSmtpPassword(client: PoolClient): Promise<string | null> {
  const row = (await client.query<{ ciphertext: string; nonce: string }>(
    'select s.ciphertext,s.nonce from mail_settings m join secrets s on s.key=m.secret_key')).rows[0];
  if (!row) return null;
  const raw = Buffer.from(row.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(row.nonce, 'base64'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
}
