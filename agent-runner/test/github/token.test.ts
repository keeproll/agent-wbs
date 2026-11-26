import { describe, expect, test } from 'vitest';
import { CredentialError, generateRunnerKeyPair, sealCredential } from '../../src/github/credential.ts';
import { ghTokenSource, sealedTokenSource } from '../../src/github/token.ts';

const TOKEN = 'github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz';

describe('토큰 방식: 서버의 봉인 값', () => {
  test('봉인 값을 받아 열고, 다시 부르면 서버에 묻지 않는다', async () => {
    const keys = generateRunnerKeyPair();
    let fetches = 0;
    const source = sealedTokenSource(() => {
      fetches += 1;
      return Promise.resolve(sealCredential(keys.publicKey, TOKEN));
    }, keys.privateKey);
    expect((await source.token()).reveal()).toBe(TOKEN);
    expect((await source.token()).reveal()).toBe(TOKEN);
    expect(fetches).toBe(1);
  });

  test('invalidate() 뒤에는 서버에서 새 봉인 값을 받는다(자격 증명 교체·401)', async () => {
    const keys = generateRunnerKeyPair();
    const tokens = [TOKEN, `${TOKEN}-rotated`];
    const source = sealedTokenSource(
      () => Promise.resolve(sealCredential(keys.publicKey, tokens.shift() ?? '')),
      keys.privateKey,
    );
    expect((await source.token()).reveal()).toBe(TOKEN);
    source.invalidate();
    expect((await source.token()).reveal()).toBe(`${TOKEN}-rotated`);
  });

  test('열 수 없는 봉인 값은 CredentialError이고 캐시하지 않는다', async () => {
    const keys = generateRunnerKeyPair();
    const other = generateRunnerKeyPair();
    let fetches = 0;
    const source = sealedTokenSource(() => {
      fetches += 1;
      return Promise.resolve(sealCredential(other.publicKey, TOKEN));
    }, keys.privateKey);
    await expect(source.token()).rejects.toThrow(CredentialError);
    await expect(source.token()).rejects.toThrow(CredentialError);
    expect(fetches).toBe(2);
  });
});

describe('gh 로그인 방식', () => {
  test('gh auth token을 argv로 실행해 결과를 Secret으로 돌려준다', async () => {
    const calls: [string, string[]][] = [];
    const source = ghTokenSource((command, args) => {
      calls.push([command, args]);
      return Promise.resolve({ code: 0, stdout: `${TOKEN}\n` });
    });
    const secret = await source.token();
    expect(secret.reveal()).toBe(TOKEN);
    expect(String(secret)).not.toContain(TOKEN);
    expect(calls).toEqual([['gh', ['auth', 'token', '--hostname', 'github.com']]]);
  });

  test('로그인되지 않았으면 출력 내용 없이 CredentialError', async () => {
    const source = ghTokenSource(() => Promise.resolve({ code: 1, stdout: 'leaked-output-value' }));
    const error = (await source.token().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).not.toContain('leaked-output-value');
    expect(error.message).toMatch(/gh auth login/);
  });

  test('빈 출력은 거부한다', async () => {
    const source = ghTokenSource(() => Promise.resolve({ code: 0, stdout: '\n' }));
    await expect(source.token()).rejects.toThrow(CredentialError);
  });

  test('실행 자체가 실패해도(gh 미설치) CredentialError', async () => {
    const source = ghTokenSource(() => Promise.reject(new Error('spawn gh ENOENT')));
    await expect(source.token()).rejects.toThrow(CredentialError);
  });
});
