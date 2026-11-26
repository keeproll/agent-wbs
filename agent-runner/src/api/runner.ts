import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { ApiError, type ApiClient, type ApiRequest, type ApiResponse } from './client.ts';
import { Outbox, authenticationFailed, retryable, retryDelay, type OutboxOptions } from './outbox.ts';
import { State, validEpoch, type Message } from '../state/state.ts';

type Command = ApiResponse<'getCommands'>['body']['commands'][number];
type CommandResult = ApiRequest<'reportCommandResult'>['body'];
export interface RunnerOptions {
  state: State;
  api: ApiClient;
  version: string;
  /** M4-03이 실제 프로세스·파일 정리와 보유 해제 증거를 제공한다. */
  cleanup?: (command: Command) => Promise<CommandResult>;
  now?: () => number;
  monotonic?: () => number;
  onRejected?: OutboxOptions['onRejected'];
  warn?: (message: string) => void;
}

export class Runner {
  readonly outbox: Outbox;
  heartbeatSeconds = 60;
  policy: ApiResponse<'getRunnerPolicy'>['body'] | undefined;
  private readonly state: State;
  private readonly api: ApiClient;
  private readonly version: string;
  private readonly cleanup: RunnerOptions['cleanup'];
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private etag: string | undefined;
  private policyEpoch: number | undefined;
  private polling: Promise<void> | undefined;
  private beating: Promise<void> | undefined;
  private started = false;
  private sessionEpoch: number | undefined;
  private synchronized = false;
  private readonly monotonic: () => number;
  private readonly commandDeadlines = new Map<string, { revision: string; at: number }>();
  private readonly loggedAlerts = new Map<string, number>();

  constructor({ state, api, version, cleanup, now = Date.now, monotonic, onRejected, warn = () => undefined }: RunnerOptions) {
    this.state = state;
    this.api = api;
    this.version = version;
    this.cleanup = cleanup;
    this.now = now;
    this.warn = warn;
    this.monotonic = monotonic ?? (() => performance.now());
    this.outbox = new Outbox(state, api, { now, ...(monotonic && { monotonic }), onRejected: async (entry) => {
      warn(`${entry.operation}: ${entry.code ?? '보고 거부'} — 거부 기록을 확인하세요.`);
      this.reportRejectionAlerts();
      await onRejected?.(entry);
    } });
    this.reportRejectionAlerts();
  }

  private reportRejectionAlerts(): void {
    for (const alert of this.state.rejectionAlerts) {
      if (this.loggedAlerts.get(alert.code) === alert.revision) continue;
      this.warn(`${alert.level}: ${alert.detail}`);
      this.loggedAlerts.set(alert.code, alert.revision);
    }
  }

  get messages(): Message[] { return this.state.snapshot.inbox; }
  get ready(): boolean { return this.synchronized && this.state.snapshot.pendingEpoch === null; }
  get readinessWarnings(): string[] {
    return [...this.outbox.readinessWarnings, ...(this.ready ? [] : ['초기화 정리가 끝나기를 기다립니다.'])];
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.startSession();
  }

  private async startSession(): Promise<void> {
    const { epoch, pendingEpoch, runnerId } = this.state.snapshot;
    if (!this.started || pendingEpoch !== null || this.sessionEpoch === epoch) return;
    await this.outbox.enqueue('reportSession', { epoch, body: { runnerId, event: 'start', at: new Date(this.now()).toISOString() } });
    this.sessionEpoch = epoch;
  }

  async stop(reason: NonNullable<ApiRequest<'reportSession'>['body']['reason']>): Promise<void> {
    const { epoch, pendingEpoch, runnerId } = this.state.snapshot;
    if (!this.started) return;
    this.started = false;
    if (pendingEpoch === null && this.sessionEpoch === epoch) {
      await this.outbox.enqueue('reportSession', { epoch, body: { runnerId, event: 'stop', reason, at: new Date(this.now()).toISOString() } });
      if (this.synchronized) await this.outbox.flush();
    }
  }

  heartbeat(): Promise<void> {
    this.beating ??= this.beat().finally(() => { this.beating = undefined; });
    return this.beating;
  }

  private async beat(): Promise<void> {
    const { epoch, runnerId } = this.state.snapshot;
    const response = await this.api('heartbeat', { epoch, body: { runnerId, version: this.version, epoch } });
    const header = response.headers.get('x-current-epoch');
    if (header === null || !/^\d+$/.test(header) || !validEpoch(Number(header))) throw new Error('heartbeat 응답에 올바른 초기화 번호가 없습니다.');
    await this.state.observeEpoch(Number(header));
  }

  poll(): Promise<void> {
    this.polling ??= this.pollOnce().catch(async (error: unknown) => {
      if (error instanceof ApiError && error.error?.code === 'EPOCH_MISMATCH') {
        await this.state.resetAfterMismatch(error.error.details?.currentEpoch);
        return;
      }
      throw error;
    }).finally(() => { this.polling = undefined; });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    await this.state.maintainRejections();
    this.reportRejectionAlerts();
    const response = await this.api('getCommands', { epoch: this.state.snapshot.epoch });
    await this.state.observeEpoch(response.body.currentEpoch);
    const activeCommands = new Set(response.body.commands.map((c) => JSON.stringify([c.epoch, c.id])));
    for (const key of this.commandDeadlines.keys()) if (!activeCommands.has(key)) this.commandDeadlines.delete(key);
    await this.state.syncCommands(response.body.commands);
    this.reportRejectionAlerts();
    if (response.body.commands.length > 0) {
      this.synchronized = false;
      for (const command of response.body.commands) {
        if (command.kind !== 'reset-cleanup' || !validEpoch(command.epoch)) throw new Error('알 수 없는 정리 명령입니다.');
        // 같은 epoch 명령도 새 작업보다 먼저 끝내야 한다.
        if (this.state.snapshot.pendingEpoch === null) {
          await this.state.update((draft) => { draft.pendingEpoch = draft.epoch; });
        }
        const queued = this.state.snapshot.outbox.find((e) => e.operation === 'reportCommandResult' && e.request.params?.id === command.id);
        if (queued) continue;
        const retry = this.state.commandDelay(command.epoch, command.id, this.now());
        const key = JSON.stringify([command.epoch, command.id]);
        let deadline = this.commandDeadlines.get(key);
        if (!deadline || deadline.revision !== retry.revision) {
          deadline = { revision: retry.revision, at: this.monotonic() + retry.delay };
          this.commandDeadlines.set(key, deadline);
        }
        if (deadline.at > this.monotonic()) continue;
        if (!this.cleanup) { this.warn('정리 구현이 연결되지 않아 새 작업을 보류합니다.'); return; }
        const result = await this.cleanup(command);
        await this.outbox.enqueue('reportCommandResult', { epoch: command.epoch, params: { id: command.id }, body: result });
      }
      await this.outbox.flush(true);
      return;
    }
    // 빈 명령 목록은 서버가 정리 결과를 확정했다는 확인이다.
    await this.state.update((draft) => {
      if (draft.pendingEpoch === null) return;
      if (draft.pendingEpoch !== response.body.currentEpoch) return;
      draft.epoch = draft.pendingEpoch;
      draft.pendingEpoch = null;
      draft.cursor = null;
      draft.inbox = [];
    });
    if (this.state.snapshot.pendingEpoch !== null) return;
    this.synchronized = true;
    await this.startSession();
    const epoch = this.state.snapshot.epoch;
    if (this.policyEpoch !== epoch) this.etag = undefined;
    const policy = await this.api('getRunnerPolicy', { epoch, ...(this.etag && { ifNoneMatch: this.etag }) });
    if (policy.status === 200) {
      if (!Number.isFinite(policy.body.heartbeatSeconds) || policy.body.heartbeatSeconds <= 0) throw new Error('heartbeat 주기가 올바르지 않습니다.');
      this.policy = policy.body;
      this.heartbeatSeconds = policy.body.heartbeatSeconds;
      this.etag = policy.headers.get('etag') ?? undefined;
      this.policyEpoch = epoch;
    }
    if (this.state.snapshot.epoch !== epoch || this.state.snapshot.pendingEpoch !== null) return;
    const { cursor } = this.state.snapshot;
    const messages = await this.api('pollMessages', { epoch, query: cursor === null ? {} : { cursor } });
    await this.state.update((draft) => {
      if (draft.epoch !== epoch || draft.pendingEpoch !== null) return;
      for (const message of messages.body.messages) {
        if (!draft.inbox.some((m) => m.id === message.id)) draft.inbox.push(message);
      }
      // null은 다음 페이지가 없다는 뜻이다. 마지막 커서를 잊으면 첫 페이지로 되돌아간다.
      if (messages.body.nextCursor !== null) draft.cursor = messages.body.nextCursor;
    });
    await this.outbox.flush();
  }

  /** 실행 계층이 실제로 지시문을 전달한 뒤 호출한다. 수신만으로는 ack하지 않는다. */
  async ackMessage(messageId: string): Promise<void> {
    const { inbox, epoch } = this.state.snapshot;
    if (!inbox.some((m) => m.id === messageId)) throw new Error('수신함에 없는 메시지입니다.');
    await this.outbox.enqueue('ackMessage', { epoch, params: { messageId } });
  }

  /** heartbeat는 보고 재전송·정리·메시지 조회에 가로막히지 않는 별도 반복으로 보낸다. */
  async run(signal: AbortSignal): Promise<void> {
    await this.start();
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const loop = async (work: () => Promise<void>, interval: () => number) => {
      let failures = 0;
      while (!controller.signal.aborted) {
        let delay = interval();
        try { await work(); failures = 0; }
        catch (error) {
          if (authenticationFailed(error)) throw error;
          this.warn(error instanceof ApiError ? error.message : 'Runner 통신 또는 정리를 완료하지 못했습니다.');
          delay = retryable(error) ? retryDelay(failures++, error, this.now(), Math.random()) : 60_000;
        }
        try { await sleep(delay, undefined, { signal: controller.signal }); }
        catch { if (!controller.signal.aborted) throw new Error('대기 중 오류가 발생했습니다.'); }
      }
    };
    const loops = [loop(() => this.heartbeat(), () => this.heartbeatSeconds * 1000), loop(() => this.poll(), () => 5000)];
    try { await Promise.all(loops); }
    finally {
      stop();
      await Promise.allSettled(loops);
      signal.removeEventListener('abort', stop);
    }
  }
}
