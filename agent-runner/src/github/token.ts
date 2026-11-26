import { execFile } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { CredentialError, openSealedCredential } from './credential.ts';
import { Secret } from '../security/secret.ts';

/**
 * GitHub 클라이언트에 넘길 토큰 공급원(architecture 「GitHub 토큰 전달」, G §9.5-4-1).
 * 두 방식 모두 토큰을 `Secret`으로만 돌려주고, 로그·오류에 값을 싣지 않는다.
 */
export interface TokenSource {
  token: () => Promise<Secret>;
  /** 다음 요청 때 새로 가져오게 한다(401·자격 증명 교체 뒤). */
  invalidate: () => void;
}

/** 토큰 방식: `GET /runner/github/credential`의 `sealed`를 Runner 개인키로 연다. */
export function sealedTokenSource(fetchSealed: () => Promise<string>, privateKey: KeyObject): TokenSource {
  // invalidate() 때마다 세대를 올린다. 이전 세대에 시작한 조회의 결과는 캐시하지도, 돌려주지도 않는다.
  let generation = 0;
  let current: { generation: number; promise: Promise<Secret> } | undefined;
  const load = (): Promise<Secret> => {
    if (current?.generation !== generation) {
      const mine = generation;
      const promise = fetchSealed().then((sealed) => openSealedCredential(privateKey, sealed));
      current = { generation: mine, promise };
      // 실패한 조회는 캐시에 남기지 않는다.
      promise.catch(() => {
        if (current?.promise === promise) current = undefined;
      });
    }
    return current.promise;
  };
  return {
    async token() {
      for (;;) {
        const started = generation;
        const secret = await load();
        if (started === generation) return secret;
        // 기다리는 동안 무효화됐다. 옛 토큰을 쓰지 않고 현재 세대로 다시 받는다.
      }
    },
    invalidate() {
      generation += 1;
      current = undefined;
    },
  };
}

export type RunCommand = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const runFile: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    // shell 없이 argv로 실행한다(architecture 「명령 실행」).
    execFile(command, args, { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout });
    });
  });

/** gh 로그인 방식: 서버에 비밀값이 없고 `gh auth token`으로 매번 읽는다. */
export function ghTokenSource(run: RunCommand = runFile): TokenSource {
  return {
    async token() {
      let result: { code: number; stdout: string };
      try {
        result = await run('gh', ['auth', 'token', '--hostname', 'github.com']);
      } catch {
        throw new CredentialError('gh를 실행할 수 없습니다. gh 설치를 확인하세요.');
      }
      const value = result.stdout.trim();
      // 출력에 토큰 일부가 있을 수 있어 메시지에 넣지 않는다.
      if (result.code !== 0 || value === '') {
        throw new CredentialError('gh 로그인 토큰을 읽지 못했습니다. gh auth login으로 다시 로그인하세요.');
      }
      return new Secret(value);
    },
    invalidate() {
      // 매번 gh에서 읽으므로 비울 캐시가 없다.
    },
  };
}
