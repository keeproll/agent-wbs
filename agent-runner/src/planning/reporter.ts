import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, type ApiClient, type ApiRequest, type ApiResponse } from '../api/client.ts';
import { authenticationFailed, retryDelay, retryable } from '../api/outbox.ts';
import type { ReportId } from '../state/state.ts';
import type { PlanningCheckpoint } from './checkpoint.ts';

/*
 * Planning 보고를 보내고 응답을 돌려받는다.
 *
 * 기존 Outbox(보고 대기함)를 쓰지 않는 이유: Outbox는 응답 본문을 버린다. Planning은 응답이 다음 단계의 입력이다
 * (예: 초안 revision, CP 번호). 대신 Outbox와 같은 약속을 지킨다.
 * - 멱등 키 형식은 Outbox의 일반 보고 키 `<operation>:<runnerId>:<uuid>`와 같다.
 * - 보내기 **전에** 키와 본문을 진행 기록에 저장한다. 같은 job에서 같은 이름의 요청을 다시 보내면 저장한 키·본문을 그대로 쓴다.
 *   왜: 서버는 처리했는데 응답을 잃은 경우, 새 키로 보내면 같은 일을 두 번 하고, 같은 키에 다른 본문을 보내면 거부된다.
 * - 네트워크·408·429·5xx는 Outbox와 같은 간격 규칙(retryDelay)으로 다시 보낸다.
 */

/** 이 job을 더 진행하면 안 되는 거부. 실패 보고도 보내지 않는다(보내도 받아 주지 않는다). */
export class PlanningStopped extends Error {
  override name = 'PlanningStopped';
  readonly code: 'LEASE_LOST' | 'EPOCH_MISMATCH' | 'AUTHENTICATION_FAILED';
  constructor(code: PlanningStopped['code'], message: string) { super(message); this.code = code; }
}
/** 서버가 보고를 거부했거나 다시 보내도 닿지 않았다. 단계 실패로 처리한다. */
export class PlanningReportFailed extends Error {
  override name = 'PlanningReportFailed';
  readonly operation: ReportId;
  readonly code: string;
  constructor(operation: ReportId, code: string, message: string) { super(message); this.operation = operation; this.code = code; }
}

export interface ReporterOptions {
  api: ApiClient;
  epoch: number;
  runnerId: string;
  jobId: string;
  checkpoint: PlanningCheckpoint;
  /** 일시 오류에서 다시 보내는 최대 횟수(처음 포함). 기본 6 */
  maxAttempts?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  signal?: AbortSignal;
}

type Request<K extends ReportId> = Omit<ApiRequest<K>, 'idempotencyKey' | 'epoch'>;

export class PlanningReporter {
  private readonly sleep: NonNullable<ReporterOptions['sleep']>;
  private readonly options: ReporterOptions;
  constructor(options: ReporterOptions) {
    this.options = options;
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  /**
   * `name`은 job 안에서 요청을 구분하는 이름이다(예: `progress:codex:run`, `draft`).
   * `request`가 함수면 이 job에서 처음 보낼 때만 불러 본문을 만든다. 이미 보낸 적 있으면 저장한 본문을 다시 보낸다.
   */
  async send<K extends ReportId>(operation: K, name: string, request: Request<K> | (() => Promise<Request<K>>)): Promise<ApiResponse<K>> {
    const { api, epoch, runnerId, jobId, checkpoint, maxAttempts = 6, now = Date.now, random = Math.random, signal } = this.options;
    let sent = checkpoint.sent(jobId, name);
    if (!sent) {
      sent = { key: `${operation}:${runnerId}:${randomUUID()}`, request: typeof request === 'function' ? await request() : request };
      await checkpoint.recordSent(jobId, name, sent);
    }
    const full = { ...(sent.request as Request<K>), epoch, idempotencyKey: sent.key } as unknown as ApiRequest<K>;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await api(operation, full);
      } catch (error) {
        if (error instanceof ApiError && (error.error?.code === 'LEASE_LOST' || error.error?.code === 'EPOCH_MISMATCH')) {
          throw new PlanningStopped(error.error.code, `${operation}: ${error.error.message}`);
        }
        if (authenticationFailed(error)) throw new PlanningStopped('AUTHENTICATION_FAILED', `${operation}: Runner 인증이 거부되었습니다.`);
        if (!retryable(error) || attempt + 1 >= maxAttempts) {
          const code = error instanceof ApiError ? error.error?.code ?? `HTTP_${String(error.status)}` : 'TRANSPORT';
          const message = error instanceof ApiError ? error.error?.message ?? error.message : '서버에 보고하지 못했습니다.';
          throw new PlanningReportFailed(operation, code, `${operation} ${code}: ${message}`);
        }
        await this.sleep(retryDelay(attempt, error, now(), random()), signal);
      }
    }
  }
}
