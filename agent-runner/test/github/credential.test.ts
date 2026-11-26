import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import {
  CredentialError,
  generateRunnerKeyPair,
  openSealedCredential,
  sealCredential,
} from '../../src/github/credential.ts';

const TOKEN = 'github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz';

describe('봉인 자격 증명', () => {
  test('Runner 공개키로 봉인한 값은 같은 Runner 개인키로만 열린다', () => {
    const runner = generateRunnerKeyPair();
    const sealed = sealCredential(runner.publicKey, TOKEN);
    const secret = openSealedCredential(runner.privateKey, sealed);
    expect(secret.reveal()).toBe(TOKEN);
  });

  test('봉인 값과 연 값 어디에도 평문이 드러나지 않는다', () => {
    const runner = generateRunnerKeyPair();
    const sealed = sealCredential(runner.publicKey, TOKEN);
    expect(sealed).not.toContain(TOKEN);
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain(TOKEN);
    const secret = openSealedCredential(runner.privateKey, sealed);
    expect(JSON.stringify({ secret })).not.toContain(TOKEN);
    expect(inspect(secret)).not.toContain(TOKEN);
    expect(String(secret)).not.toContain(TOKEN);
  });

  test('같은 토큰도 봉인할 때마다 값이 달라진다(재사용 추적 방지)', () => {
    const runner = generateRunnerKeyPair();
    expect(sealCredential(runner.publicKey, TOKEN)).not.toBe(sealCredential(runner.publicKey, TOKEN));
  });

  test('다른 Runner의 개인키로는 열 수 없다', () => {
    const a = generateRunnerKeyPair();
    const b = generateRunnerKeyPair();
    const sealed = sealCredential(a.publicKey, TOKEN);
    expect(() => openSealedCredential(b.privateKey, sealed)).toThrow(CredentialError);
  });

  test.each([
    ['1바이트 변조', (raw: Buffer) => { raw[raw.length - 1] = (raw.at(-1) ?? 0) ^ 1; }],
    ['버전 변조', (raw: Buffer) => { raw[0] = 2; }],
    ['임시 공개키 변조', (raw: Buffer) => { raw[5] = (raw[5] ?? 0) ^ 1; }],
  ])('%s된 봉인 값은 거부한다', (_, mutate) => {
    const runner = generateRunnerKeyPair();
    const raw = Buffer.from(sealCredential(runner.publicKey, TOKEN), 'base64url');
    mutate(raw);
    expect(() => openSealedCredential(runner.privateKey, raw.toString('base64url'))).toThrow(CredentialError);
  });

  test.each(['', 'not base64 !!', Buffer.alloc(10).toString('base64url')])('형식이 틀린 값(%j)은 거부한다', (value) => {
    const runner = generateRunnerKeyPair();
    expect(() => openSealedCredential(runner.privateKey, value)).toThrow(CredentialError);
  });

  test('오류 메시지에 봉인 값이 들어가지 않는다', () => {
    const a = generateRunnerKeyPair();
    const b = generateRunnerKeyPair();
    const sealed = sealCredential(a.publicKey, TOKEN);
    try {
      openSealedCredential(b.privateKey, sealed);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(sealed);
      expect(String(error)).not.toContain(TOKEN);
    }
  });

  test('빈 토큰은 봉인하지 않는다', () => {
    const runner = generateRunnerKeyPair();
    expect(() => sealCredential(runner.publicKey, '')).toThrow(CredentialError);
  });

  test('공개키는 PEM 문자열로 주고받을 수 있다', () => {
    const runner = generateRunnerKeyPair();
    expect(runner.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(openSealedCredential(runner.privateKey, sealCredential(runner.publicKey, TOKEN)).reveal()).toBe(TOKEN);
  });
});

describe('봉인 형식 v1 고정 벡터(서버 독립 구현과 맞추는 기준)', () => {
  const vector = JSON.parse(
    readFileSync(new URL('./fixtures/sealed-v1-vector.json', import.meta.url), 'utf8'),
  ) as { sealed: string; recipientPrivateHex: string; recipientPem: string; token: string; ephemeralPublicHex: string; nonceHex: string };
  // X25519 개인키 raw 32바이트 → PKCS#8 DER
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(vector.recipientPrivateHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });

  test('다른 언어로 만든 v1 봉인 값을 연다', () => {
    expect(openSealedCredential(privateKey, vector.sealed).reveal()).toBe(vector.token);
  });

  test('바이트 배치가 계약 보완안과 같다: 버전|임시 공개키|nonce|tag|암호문', () => {
    const raw = Buffer.from(vector.sealed, 'base64url');
    expect(raw[0]).toBe(1);
    expect(raw.subarray(1, 33).toString('hex')).toBe(vector.ephemeralPublicHex);
    expect(raw.subarray(33, 45).toString('hex')).toBe(vector.nonceHex);
    expect(raw.length).toBe(61 + Buffer.byteLength(vector.token, 'utf8'));
    expect(vector.sealed).not.toContain('=');
  });

  test('벡터의 공개키 PEM으로 봉인한 값도 같은 개인키로 열린다', () => {
    expect(openSealedCredential(privateKey, sealCredential(vector.recipientPem, vector.token)).reveal()).toBe(vector.token);
  });
});
