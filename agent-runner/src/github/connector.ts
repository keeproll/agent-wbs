import { randomUUID } from 'node:crypto';
import { ApiError, type ApiClient, type ApiRequest } from '../api/client.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { retryDelay, retryable } from '../api/outbox.ts';
import type { ConnectionStatus, GithubMode, PermissionDenied, Permissions } from './client.ts';
import { generateRunnerKeyPair, type RunnerKeyPair } from './credential.ts';
import { sealedTokenSource, type TokenSource } from './token.ts';

/** POST /runner/github/status 본문 */
export type GithubStatusReport = ApiRequest<'reportGithubStatus'>['body'];

const UNVERIFIED_WARNING = '쓰기 권한 일부 미확인: 첫 실제 쓰기에서 확인합니다.';

/**
 * 연결 확인 결과·현재 권한을 `reportGithubStatus` 본문으로 바꾼다(contracts §3.1, 입력 규칙 `githubStatusConsistent`).
 *
 * - `ok`는 인증에 성공하고 `missing`이 하나도 없을 때만 true다.
 * - 권한을 확인하지 못했으면(`scopes` null) `ok`는 false다.
 * - `unverified`가 있으면 `warning`을 반드시 싣는다. 왜: 서버 입력 규칙이 warning 없는 unverified를 400으로 거부한다.
 */
export function githubStatusBody(status: Omit<ConnectionStatus, 'superseded'>, permissions: Permissions | null = status.permissions): GithubStatusReport {
  const values = permissions ? Object.values(permissions) : [];
  const missing = permissions ? (Object.keys(permissions) as (keyof Permissions)[]).filter((k) => permissions[k] === 'missing') : [];
  const ok = status.ok && permissions !== null && missing.length === 0;
  const warning = values.includes('unverified') ? (status.warning ?? UNVERIFIED_WARNING) : status.warning;
  const error = status.error ?? (missing.length > 0 ? `필요한 권한 부족: ${missing.join(', ')}` : undefined);
  return {
    mode: status.mode,
    ok,
    account: status.account,
    scopes: permissions ? { ...permissions } : null,
    expiresAt: status.expiresAt,
    ...(warning !== undefined && { warning }),
    ...(error !== undefined && { error }),
  };
}

export interface GithubConnectorDeps {
  api: ApiClient;
  /** 현재 프로젝트 epoch(M4-01 상태 계층) */
  epoch: () => number;
  identity: () => { runnerId: string; hostId: string; bootId: string };
  /** 상태 보고를 영속 outbox에 넣는다(M4-01). 재전송·거부 기록은 outbox가 맡는다. */
  enqueueStatus: (body: GithubStatusReport) => Promise<void>;
  keyPair?: RunnerKeyPair;
  /** 네트워크 실패 시 같은 등록 요청을 다시 보내는 최대 횟수 */
  registerRetries?: number;
  /** 재전송 전 대기(기본: outbox와 같은 지수 백오프·Retry-After). */
  retryWait?: (attempt: number, error: unknown) => Promise<void>;
}

/**
 * GitHub 자격 증명과 권한 상태를 서버와 잇는 연결부(M4-04 + 계약 보완).
 *
 * 1. 프로세스를 시작할 때마다 새 X25519 키를 만들고 `POST /runner/github/key`로 등록해 `keyId`를 받는다.
 * 2. 토큰 방식이면 `GET /runner/github/credential?keyId=`로 봉인 값을 받아 연다.
 *    404면(서버 재시작 등으로 등록이 사라짐) **새 Idempotency-Key**로 다시 등록하고 한 번 더 조회한다.
 *    왜: 옛 키로 재전송하면 서버는 저장된 응답만 재생하고 등록을 다시 하지 않아 계속 404다(contracts §3.1).
 * 3. 연결 확인 결과와 첫 쓰기 403(권한 부족)을 `reportGithubStatus`로 보고한다.
 */
export class GithubConnector {
  readonly #d: GithubConnectorDeps;
  readonly #keys: RunnerKeyPair;
  #keyId: string | undefined;
  #registering: Promise<string> | undefined;
  #last: Omit<ConnectionStatus, 'superseded'> | undefined;

  constructor(deps: GithubConnectorDeps) {
    this.#d = deps;
    this.#keys = deps.keyPair ?? generateRunnerKeyPair();
  }

  get keyId(): string | undefined {
    return this.#keyId;
  }

  /** 등록을 한 번 수행한다. 같은 요청의 네트워크 재전송은 같은 멱등 키를 유지한다. */
  register(): Promise<string> {
    this.#registering ??= this.#register().finally(() => { this.#registering = undefined; });
    return this.#registering;
  }

  async #register(): Promise<string> {
    const { runnerId, hostId, bootId } = this.#d.identity();
    const idempotencyKey = `github-key:${runnerId}:${randomUUID()}`;
    const retries = this.#d.registerRetries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await this.#d.api('registerGithubKey', {
          epoch: this.#d.epoch(),
          idempotencyKey,
          body: { runnerId, hostId, bootId, publicKeyPem: this.#keys.publicKey, sealedVersion: 1 },
        });
        this.#keyId = res.body.keyId;
        return res.body.keyId;
      } catch (error) {
        if (attempt >= retries || !retryable(error)) throw error;
        await (this.#d.retryWait ?? ((n, e) => sleep(retryDelay(n, e, Date.now(), Math.random()))))(attempt, error);
      }
    }
  }

  /** 봉인 값을 받는다. 등록이 없거나 404면 새 요청으로 다시 등록한 뒤 한 번 더 조회한다. */
  async fetchSealed(): Promise<string> {
    const keyId = this.#keyId ?? (await this.register());
    try {
      return (await this.#d.api('getGithubCredential', { epoch: this.#d.epoch(), query: { keyId } })).body.sealed;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      this.#keyId = undefined;
      const fresh = await this.register();
      return (await this.#d.api('getGithubCredential', { epoch: this.#d.epoch(), query: { keyId: fresh } })).body.sealed;
    }
  }

  /** 토큰 방식의 토큰 공급원. GitHub 클라이언트의 `token`에 넘긴다. */
  tokenSource(): TokenSource {
    return sealedTokenSource(() => this.fetchSealed(), this.#keys.privateKey);
  }

  /**
   * 연결 확인 결과를 보고한다. 더 새로운 확인에 밀린 결과(`superseded`)는 현재 상태가 아니므로 보내지 않는다.
   * @returns 보낸 본문(보내지 않았으면 null)
   */
  async reportConnection(status: ConnectionStatus): Promise<GithubStatusReport | null> {
    if (status.superseded) return null;
    this.#last = status;
    const body = githubStatusBody(status);
    await this.#d.enqueueStatus(body);
    return body;
  }

  /**
   * 첫 실제 쓰기가 권한 부족 403을 받았을 때(GitHub 클라이언트 `onPermissionDenied`). 현재 권한으로 다시 보고한다.
   * 서버는 missing 전환을 보고 관리자 개입 알림을 만든다(contracts §3.1).
   */
  async reportPermissionDenied(event: PermissionDenied, permissions: Permissions, mode: GithubMode): Promise<GithubStatusReport> {
    const base = this.#last ?? { mode, ok: true, account: null, permissions, expiresAt: null };
    const rest: Omit<ConnectionStatus, 'superseded'> = { ...base, mode, permissions, error: event.message };
    const body = githubStatusBody(rest, permissions);
    this.#last = { ...rest, ok: body.ok };
    await this.#d.enqueueStatus(body);
    return body;
  }
}
