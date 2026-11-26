// contracts §6 「봉인 형식 v1」: 문서에 적은 바이트 배치·파생식만으로 공용 고정 벡터를 연다.
// 서버(WBS)와 Runner는 같은 벡터(contracts/fixtures/sealed-v1-vector.json)를 통과해야 한다.
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

interface Vector {
  sealed: string;
  recipientPrivateHex: string;
  recipientPublicHex: string;
  ephemeralPublicHex: string;
  nonceHex: string;
  derivedKeyHex: string;
  token: string;
  recipientPem: string;
}
const vector = JSON.parse(
  readFileSync(new URL('../../../../contracts/fixtures/sealed-v1-vector.json', import.meta.url), 'utf8'),
) as Vector;
const contracts = readFileSync(new URL('../../../../../docs/plan/contracts.md', import.meta.url), 'utf8');

// X25519 키를 node:crypto에 넘기기 위한 DER 머리말(PKCS#8 개인키, SPKI 공개키)
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const INFO = 'agentwbs/github-credential/v1';

test('계약 문서에 v1 정의(info 문자열·AAD·padding 없음)가 적혀 있다', () => {
  expect(contracts).toContain('### 6.1 봉인 형식 v1');
  expect(contracts).toContain(INFO);
  expect(contracts).toContain('sealed-v1-vector.json');
});

test('바이트 배치: 버전 1 | 임시 공개키 32 | nonce 12 | tag 16 | 암호문', () => {
  expect(vector.sealed).toMatch(/^[A-Za-z0-9_-]+$/); // padding(=) 없는 base64url
  const raw = Buffer.from(vector.sealed, 'base64url');
  expect(raw[0]).toBe(0x01);
  expect(raw.subarray(1, 33).toString('hex')).toBe(vector.ephemeralPublicHex);
  expect(raw.subarray(33, 45).toString('hex')).toBe(vector.nonceHex);
  expect(raw.length).toBe(61 + Buffer.byteLength(vector.token, 'utf8'));
});

test('문서의 파생식으로 키를 만들고 열면 토큰이 나온다', () => {
  const raw = Buffer.from(vector.sealed, 'base64url');
  const ephemeral = raw.subarray(1, 33);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(vector.recipientPrivateHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const runnerPublic = createPublicKey(vector.recipientPem).export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
  expect(runnerPublic.toString('hex')).toBe(vector.recipientPublicHex);
  const z = diffieHellman({
    privateKey,
    publicKey: createPublicKey({ key: Buffer.concat([SPKI, ephemeral]), format: 'der', type: 'spki' }),
  });
  const key = Buffer.from(hkdfSync('sha256', z, Buffer.concat([ephemeral, runnerPublic]), Buffer.from(INFO, 'utf8'), 32));
  expect(key.toString('hex')).toBe(vector.derivedKeyHex);
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(33, 45));
  decipher.setAAD(Buffer.concat([Buffer.from([0x01]), ephemeral]));
  decipher.setAuthTag(raw.subarray(45, 61));
  const plain = Buffer.concat([decipher.update(raw.subarray(61)), decipher.final()]).toString('utf8');
  expect(plain).toBe(vector.token);
});
