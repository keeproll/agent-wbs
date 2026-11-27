import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from '@awbs/db';
import { ApiError, invalid } from '../changes/http.ts';

type Db = Pick<PoolClient, 'query'>;
export const fingerprint = (key: string, chatId: string) => createHash('sha256').update(`${key}|${chatId}`).digest('hex');
const encryptionKey = () => {
  const key = process.env.AWBS_SECRET_KEY;
  if (!key || !/^[a-fA-F0-9]{64}$/.test(key)) throw new ApiError('UNAVAILABLE', {}, [], '비밀값 저장 키 AWBS_SECRET_KEY를 설정하세요.');
  return Buffer.from(key, 'hex');
};

/** GitHub 설정과 같은 AES-256-GCM 형식이다. 평문은 호출 동안만 메모리에 둔다. */
export async function tokenKey(db: Db, token?: string): Promise<string> {
  if (token === undefined) {
    const row = (await db.query<{ secret_key: string | null }>('select secret_key from notify_settings where singleton')).rows[0];
    if (!row?.secret_key) throw invalid([{ path: 'botToken', rule: 'required', message: 'Bot Token을 입력하세요.' }]);
    return row.secret_key;
  }
  if (!/^[0-9]{6,12}:[A-Za-z0-9_-]{20,}$/.test(token)) throw invalid([{ path: 'botToken', rule: 'format', message: '새 Bot Token을 입력하세요. 빈 값과 마스킹 값은 쓸 수 없습니다.' }]);
  const key = `telegram:${createHash('sha256').update(token).digest('hex')}`;
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  await db.query('insert into secrets(key,ciphertext,nonce,key_version,last4) values($1,$2,$3,1,$4) on conflict(key) do nothing',
    [key, ciphertext.toString('base64'), nonce.toString('base64'), token.slice(-4)]);
  return key;
}

export async function readToken(db: Db, key: string): Promise<string> {
  const row = (await db.query<{ ciphertext: string; nonce: string }>('select ciphertext,nonce from secrets where key=$1', [key])).rows[0];
  if (!row) throw new ApiError('UNAVAILABLE');
  const data = Buffer.from(row.ciphertext, 'base64'), decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.nonce, 'base64'));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8');
}
