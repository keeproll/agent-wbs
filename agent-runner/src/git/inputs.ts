import { randomUUID } from 'node:crypto';
import { ApiError, type ApiClient, type ApiRequest, type ApiResponse } from '../api/client.ts';
import { GitSafetyError } from './repository.ts';

/**
 * 입력 변경 보고(M2-03 새 계약, contracts `reportInputChanges`).
 *
 * 입력 변경의 정답은 커밋 목록이 아니라 base와 head의 `prototype/` **트리 차이**다.
 * - base: 서버가 마지막으로 받은 입력 head. 200·409 응답의 head로 갱신한다.
 * - head: 이번에 본 원격 main 끝 커밋.
 * - 차이가 비어도 보낸다. 서버는 head를 옮긴다.
 * 예전 계약의 depth(첫 부모 깊이)는 폐기되었다(m4-integration-notes의 depth 항목 대체).
 */
export type InputObservation = Omit<ApiRequest<'reportInputChanges'>['body'], 'base' | 'head'>;
export type InputDiff = InputObservation['changes'][number];
export type PushedCommit = InputObservation['commits'][number];

const ZERO = /^0+$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MODE = /^[0-7]{6}$/;
const STATUSES = ['A', 'M', 'D', 'R', 'T'] as const;
const isStatus = (value: string): value is InputDiff['status'] => (STATUSES as readonly string[]).includes(value);

/**
 * `git diff --raw --numstat -M -z --no-abbrev <base> <head> -- prototype/` 출력을 계약의 차이 목록으로 바꾼다.
 * - -z 출력은 raw 줄을 모두 낸 뒤 numstat 줄을 같은 순서로 낸다.
 * - raw: `:<이전 모드> <새 모드> <이전 blob> <새 blob> <상태>` 다음에 경로(이름 변경은 이전·새 경로 둘).
 * - numstat: `<추가>\t<삭제>\t<경로>`. 이름 변경은 `<추가>\t<삭제>\t` 다음에 이전·새 경로. 바이너리는 `-`(0으로 보냄).
 * - 없는 쪽의 모드 000000·blob 0000…은 null로 보낸다. 이름 변경 유사도(R100)는 상태 R만 남긴다.
 * 왜 직접 해석하나: 서버는 git을 보지 않으므로 Runner가 git 출력 그대로를 정확히 옮겨야 한다(계약의 신뢰 전제).
 */
export function parseRawNumstat(output: string): InputDiff[] {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const raws: { status: InputDiff['status']; path: string; from?: string; oldMode: string | null; newMode: string | null; oldBlob: string | null; newBlob: string | null }[] = [];
  let i = 0;
  while (i < tokens.length && tokens[i]?.startsWith(':')) {
    const [oldMode, newMode, oldBlob, newBlob, rawStatus] = (tokens[i] ?? '').slice(1).split(' ');
    const letter = rawStatus?.[0];
    if (!oldMode || !newMode || !oldBlob || !newBlob || !letter || !MODE.test(oldMode) || !MODE.test(newMode)) throw new GitSafetyError('입력 차이(raw) 형식을 해석할 수 없습니다.');
    if (!isStatus(letter)) throw new GitSafetyError(`입력 차이에 계약에 없는 상태(${letter})가 있습니다.`);
    const status = letter;
    const blob = (value: string) => { if (ZERO.test(value)) return null; if (!SHA.test(value)) throw new GitSafetyError('입력 차이의 blob이 전체 SHA가 아닙니다.'); return value; };
    const entry = { status, oldMode: ZERO.test(oldMode) ? null : oldMode, newMode: ZERO.test(newMode) ? null : newMode, oldBlob: blob(oldBlob), newBlob: blob(newBlob) };
    if (status === 'R') {
      const from = tokens[i + 1]; const path = tokens[i + 2];
      if (from === undefined || path === undefined) throw new GitSafetyError('입력 차이(이름 변경) 경로가 없습니다.');
      raws.push({ ...entry, from, path }); i += 3;
    } else {
      const path = tokens[i + 1];
      if (path === undefined) throw new GitSafetyError('입력 차이 경로가 없습니다.');
      raws.push({ ...entry, path }); i += 2;
    }
  }
  const counts: { added: number; deleted: number }[] = [];
  while (i < tokens.length) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i] ?? '');
    if (!match) throw new GitSafetyError('입력 차이(numstat) 형식을 해석할 수 없습니다.');
    const n = (value: string | undefined) => (value === '-' || value === undefined ? 0 : Number(value));
    counts.push({ added: n(match[1]), deleted: n(match[2]) });
    // 이름 변경은 경로 칸이 비고 이전·새 경로가 따로 온다.
    i += match[3] === '' ? 3 : 1;
  }
  if (counts.length !== raws.length) throw new GitSafetyError('입력 차이의 raw와 numstat 줄 수가 다릅니다.');
  return raws.map((raw, index) => ({ ...raw, ...(counts[index] ?? { added: 0, deleted: 0 }) }));
}

/** `git log --first-parent --reverse --format=%H%x1f%cI%x1f%an%x1f%s%x1e` 출력. 화면 표시용 참고 정보다. */
export function parseCommits(output: string): PushedCommit[] {
  return output.split('\x1e').map((record) => record.replace(/^\n/, '')).filter(Boolean).map((record) => {
    const [commit, at, author, message] = record.split('\x1f');
    if (!commit || !SHA.test(commit) || !at || Number.isNaN(Date.parse(at))) throw new GitSafetyError('입력 커밋 목록 형식을 해석할 수 없습니다.');
    // 계약 Timestamp는 UTC(Z)다. git의 +09:00 표기를 UTC로 바꾼다.
    return { sha: commit, at: new Date(at).toISOString(), author: author ?? '', message: message ?? '' };
  });
}

/** 보고에 필요한 git 관측. GitRepository가 구현하고, 시험은 가짜를 넣는다. */
export interface InputSource {
  /** 원격 main을 받아 그 끝 SHA를 돌려준다. */
  fetch(): Promise<string>;
  /** base..head의 관측. base가 로컬에 없거나 판정할 수 없으면 실패한다(보고 중단). */
  inputObservation(base: string, head: string): Promise<InputObservation>;
}

export interface InputReporterOptions {
  api: ApiClient;
  epoch: () => number;
  warn: (message: string) => void;
  /** 409 뒤 다시 계산하는 최대 횟수. 그 사이에도 서버 head가 계속 바뀌면 다음 주기로 미룬다. */
  maxAttempts?: number;
  /** 서버 정책의 입력 확인 다시 시도 번호(inputRecheck). 재작성으로 멈춘 뒤 이 값이 바뀌면 다시 관측한다. */
  recheck?: () => number | undefined;
}

export type InputReport = ApiResponse<'reportInputChanges'>['body'] | { skipped: 'history_rewritten' };

/**
 * 입력 변경 보고기. 상태는 메모리에만 두고, 그 상태가 어느 epoch의 것인지 함께 기록한다.
 * - 처음(또는 재시작 뒤)에는 서버 head를 모르므로 head 자신을 base로 물어본다. 다르면 409가 서버 head를 알려 준다.
 * - 409 VERSION_CONFLICT: 응답의 `details.current.base`로 base를 바꿔 **다시 계산**해 보낸다(계약 「409 뒤 재계산」).
 * - historyRewritten: 서버가 이력 재작성으로 보고 아무것도 받지 않았다. 같은 base로는 다시 보내지 않고 멈춘다(재작성 시 중단).
 *   다시 보내는 때는 둘뿐이다(조정자 결정 2026-11-26).
 *   1) 팀장이 「복구 확인·입력 확인 다시 시도」를 눌러 정책 inputRecheck가 바뀌었을 때: 서버 head를 base로 다시 관측한다.
 *      owner가 정상 merge·복원 커밋으로 연결을 되돌렸다면 조상 관계가 성립해 서버가 받아들이고 경고를 해소한다. 아니면 다시 멈춘다.
 *   2) epoch가 바뀌었을 때(프로젝트 초기화): 이전 base·중단 상태를 모두 버린다(교차 리뷰 F2, G§4.2 ③ 「등록 전 상태」).
 */
export class InputChangeReporter {
  readonly #o: InputReporterOptions;
  #epoch: number | undefined;
  #base: string | undefined;
  #stopped: { base: string; recheck: number | undefined } | undefined;

  constructor(options: InputReporterOptions) { this.#o = options; }

  /** 서버가 마지막으로 받은 입력 head(알면). */
  get base(): string | undefined { return this.#base; }
  /** 이력 재작성으로 멈춘 경우 그 base. */
  get stoppedAt(): string | undefined { return this.#stopped?.base; }

  async report(source: InputSource): Promise<InputReport> {
    const epoch = this.#o.epoch();
    if (this.#epoch !== epoch) { this.#epoch = epoch; this.#base = undefined; this.#stopped = undefined; }
    if (this.#stopped && this.#stopped.recheck === this.#o.recheck?.()) return { skipped: 'history_rewritten' };
    const head = await source.fetch();
    // 복구 확인으로 다시 시도할 때는 서버 head(멈춘 base)를 base로 쓴다.
    let base = this.#stopped?.base ?? this.#base ?? head;
    const limit = this.#o.maxAttempts ?? 3;
    for (let attempt = 0; attempt < limit; attempt++) {
      const observation = await source.inputObservation(base, head);
      try {
        const response = await this.#o.api('reportInputChanges', { epoch, idempotencyKey: `inputs:${randomUUID()}`, body: { base, head, ...observation } });
        this.#base = response.body.head;
        if (response.body.historyRewritten) {
          this.#stopped = { base, recheck: this.#o.recheck?.() };
          this.#o.warn(`입력 이력 재작성: 마지막 입력 커밋 ${base}가 main ${head}의 조상이 아닙니다. 팀장의 복구 확인 전까지 입력 변경 보고를 멈춥니다.`);
        } else this.#stopped = undefined;
        return response.body;
      } catch (error) {
        const current = conflictBase(error);
        if (current === undefined || current === base) throw error;
        // 서버 head가 다르다(늦은·중복 보고, 재시작 뒤 첫 보고). 서버 head를 base로 다시 계산한다.
        base = current;
        this.#base = current;
      }
    }
    throw new Error(`입력 변경 보고: 서버 입력 head가 계속 바뀌어 ${String(limit)}번 안에 맞추지 못했습니다. 다음 주기에 다시 계산합니다.`);
  }
}

function conflictBase(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 409 || error.error?.code !== 'VERSION_CONFLICT') return undefined;
  const base = (error.error.details as { current?: { base?: unknown } } | undefined)?.current?.base;
  return typeof base === 'string' && SHA.test(base) ? base : undefined;
}
