import { createHash } from 'node:crypto';
import { createRedactor } from '../security/redact.ts';
import type { Secret } from '../security/secret.ts';

/**
 * GitHub REST 어댑터(architecture `github`, contracts §4.1·§6).
 *
 * - 확인: 연결(계정·권한·만료)과 저장소(접근·private·main 커밋·필수 구조).
 * - PR: `agent/<TASK>` 브랜치 → main, Task당 1개. 재시도해도 PR이 둘 생기지 않는다.
 * - commit status: `agentwbs/task|int|night|deploy`만.
 * - 병합: `PUT /pulls/{n}/merge`에 `sha=H′`, `merge_method=merge` 하나뿐. 응답 유실은 PR 조회로 대조한다.
 * 재시도 대기열(outbox)은 이 모듈 밖이며, 여기서는 오류에 `retryable`만 표시한다.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export type GithubMode = 'gh' | 'token';
export type StatusContext = 'agentwbs/task' | 'agentwbs/int' | 'agentwbs/night' | 'agentwbs/deploy';
export type StatusState = 'pending' | 'success' | 'failure' | 'error';

/** GitHub 쓰기 직전에 호출자가 권한 세대(generation)를 대조할 수 있게 넘기는 정보. */
export type WriteOperation =
  | { kind: 'pull_create'; branch: string }
  | { kind: 'pull_close'; pr: number }
  | { kind: 'branch_delete'; branch: string }
  | { kind: 'status'; sha: string; context: StatusContext }
  | { kind: 'merge'; pr: number; headSha: string };

/** 권한 이름. 원본 가이드 §9.5-4-1의 네 권한(README §4). */
export type PermissionName = 'contents' | 'pulls' | 'statuses' | 'metadata';
/**
 * 권한 상태 3가지.
 * - verified(확인됨): 읽기 응답·OAuth 범위·성공한 실제 쓰기로 확인했다.
 * - unverified(미확인): 확인할 방법이 없었다. 실행은 허용하고 경고만 띄운다.
 * - missing(부족): 범위에 없거나 실제 쓰기가 권한 부족 403을 받았다.
 */
export type PermissionState = 'verified' | 'unverified' | 'missing';
export type Permissions = Record<PermissionName, PermissionState>;

/** 실제 쓰기가 권한 부족 403을 받았을 때 호출자에게 넘기는 알림(팀장 알림용). 비밀값 없음. */
export interface PermissionDenied {
  permission: PermissionName;
  operation: WriteOperation['kind'];
  message: string;
}

export interface GitHubClientOptions {
  repo: RepoRef;
  /** 요청마다 부른다. 봉인 값을 연 `Secret`이나 `gh auth token` 결과를 돌려준다. */
  token: () => Promise<Secret>;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** 거부(throw)하면 GitHub를 호출하지 않는다. 예: 409 EXTERNAL_WRITE_BLOCKED. */
  beforeWrite?: (operation: WriteOperation) => Promise<void>;
  timeoutMs?: number;
  /**
   * 첫 실제 쓰기에서 권한 부족이 드러나면 부른다. 기다리지 않는다.
   * 동기 예외든 돌려준 Promise의 실패든 삼키고, 원래 GitHub 오류는 그대로 던진다(알림 장애로 Runner가 죽지 않게).
   */
  onPermissionDenied?: (event: PermissionDenied) => void | Promise<void>;
}

/** `reportGithubStatus` 본문과 같은 모양(비밀값 없음). */
export interface ConnectionStatus {
  mode: GithubMode;
  ok: boolean;
  account: string | null;
  /** 인증·저장소 조회에 실패하면 null. */
  permissions: Permissions | null;
  expiresAt: string | null;
  /** ok이지만 알려야 할 것(예: 쓰기 권한 미확인). */
  warning?: string;
  error?: string;
  /**
   * 이 확인이 끝나기 전에 더 새로운 연결 확인이 시작됐거나 토큰이 바뀌었다.
   * 결과는 현재 연결의 상태가 아니며 `permissions()`에도 반영되지 않았다. 화면에 현재 상태로 보이지 않는다.
   */
  superseded?: true;
}

/** `reportRepoCheck` 본문에서 fence를 뺀 모양. */
export interface RepositoryCheck {
  access: boolean;
  private: boolean | null;
  commit: string | null;
  structure: {
    uiux: boolean;
    uiuxFiles: number;
    docs: string[];
    src: boolean;
    contracts: boolean;
    agentwbs: boolean;
  } | null;
  error?: string;
}

export interface PullRequest {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  branch: string;
  headSha: string | null;
  baseSha: string | null;
  url: string | null;
}

export interface CommitStatus {
  context: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
}

export type MergeOutcome =
  /** 병합됐고 병합 커밋의 부모가 [A, H′], tree가 H′의 tree임을 확인했다. */
  | { kind: 'merged'; mergeSha: string; treeSha: string; reconciled?: true }
  /** 병합됐지만 부모·tree가 기대와 다르다. done으로 만들지 않고 알린다(main 자동 되돌림 없음). */
  | { kind: 'verify_failed'; mergeSha: string; reason: string; reconciled?: true }
  /** 409: QA 뒤 head가 바뀌었다. 대기열 1단계부터 다시. */
  | { kind: 'head_changed'; status: 409; message: string }
  /** 405: main 이동·필수 검사 미충족 등 strict 보호가 거부. */
  | { kind: 'rejected'; status: 405; message: string }
  /**
   * 결과를 모른다. 「병합 안 됨」을 확정하는 결과는 일부러 두지 않는다.
   * 타임아웃은 GitHub 쪽 처리를 취소하지 않으므로, 열린 PR을 한 번 읽었다고 늦게 적용될 병합이 없다고 말할 수 없다.
   * 호출자는 이 상태의 병합을 다음 작업으로 넘기지 말고 `reconcileMerge()`(쓰기 없음)로 다시 대조한다.
   * - `open`·`closed`: 대조 때 본 PR 상태(아직 병합 안 됨으로 보임)
   * - `read_failed`: 대조 조회 자체가 실패
   */
  | { kind: 'unknown'; observed: 'open' | 'closed' | 'read_failed'; error?: string };

export class GitHubError extends Error {
  override name = 'GitHubError';
  /** HTTP 상태. 통신 실패·시간 초과는 0, 호출 전 입력 거부는 -1. */
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryable: boolean, retryAfterSeconds: number | null = null) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const invalid = (message: string) => new GitHubError(message, -1, false);

const CONTEXTS: readonly string[] = ['agentwbs/task', 'agentwbs/int', 'agentwbs/night', 'agentwbs/deploy'];
const STATES: readonly string[] = ['pending', 'success', 'failure', 'error'];
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^agent\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const DESCRIPTION_MAX = 140;

/** `https://github.com/<owner>/<repo>`(`.git` 허용)만 받는다. 브랜치·폴더·파일 주소는 거부(G L219). */
export function parseRepoUrl(input: string): RepoRef | null {
  const url = URL.parse(input);
  if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '') return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
  if (parts.length !== 2) return null;
  const [owner = '', rawRepo = ''] = parts;
  const repo = rawRepo.replace(/\.git$/, '');
  for (const name of [owner, repo]) if (!NAME.test(name) || /^\.+$/.test(name)) return null;
  return { owner, repo };
}

/** `2026-12-20 09:00:00 +0900`·`2026-12-20 00:00:00 UTC` → ISO. 모르는 형식이면 null. */
function parseExpiration(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (?:UTC|([+-]\d{2})(\d{2}))$/.exec(value.trim());
  if (!m) return null;
  const zone = m[3] === undefined ? 'Z' : `${m[3]}:${m[4] ?? '00'}`;
  const date = new Date(`${m[1] ?? ''}T${m[2] ?? ''}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

interface StatusJson {
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
}

interface Raw {
  status: number;
  body: unknown;
  headers: Headers;
  /** 요청을 보낼 때의 권한 세대. 연결 재확인·토큰 교체 뒤의 늦은 응답을 가려낸다. */
  generation: number;
}

interface PullJson {
  number: number;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string | null };
  base: { sha: string | null };
  html_url?: string;
}

function toPull(json: PullJson): PullRequest {
  return {
    number: json.number,
    state: json.state,
    merged: json.merged ?? (json.merged_at !== undefined && json.merged_at !== null),
    mergeCommitSha: json.merge_commit_sha,
    branch: json.head.ref,
    headSha: json.head.sha,
    baseSha: json.base.sha,
    url: json.html_url ?? null,
  };
}

/**
 * 속도 제한 판정(공식 문서 「Exceeding the rate limit」).
 * - 429는 항상 속도 제한이다.
 * - 403은 `Retry-After`가 있거나(보조 제한), `x-ratelimit-remaining: 0`이거나(기본 제한),
 *   본문이 rate limit을 말할 때만 속도 제한이다. 그 밖의 403(권한 부족)은 재시도하지 않는다.
 * - 기다릴 시간: `Retry-After` 초, 없으면 `x-ratelimit-reset`(UTC 초)까지 남은 시간.
 */
function rateLimit(raw: Raw): { limited: boolean; retryAfterSeconds: number | null } {
  const retryAfter = Number(raw.headers.get('retry-after') ?? NaN);
  const hasRetryAfter = Number.isFinite(retryAfter) && retryAfter > 0;
  const message = String((raw.body as { message?: unknown } | undefined)?.message ?? '');
  const limited =
    raw.status === 429 ||
    (raw.status === 403 &&
      (hasRetryAfter || raw.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)));
  if (!limited) return { limited, retryAfterSeconds: hasRetryAfter ? retryAfter : null };
  if (hasRetryAfter) return { limited, retryAfterSeconds: retryAfter };
  // x-ratelimit-reset은 기본 제한(잔량 0)이 풀리는 시각이다. 보조 제한에는 쓰지 않는다.
  const reset = Number(raw.headers.get('x-ratelimit-reset') ?? NaN);
  if (raw.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
    return { limited, retryAfterSeconds: Math.max(1, Math.ceil(reset - Date.now() / 1000)) };
  }
  // Retry-After도 없고 잔량 0도 아니면 최소 1분 기다린다(공식 문서). 반복 시 늘리는 것은 outbox 몫이다.
  return { limited, retryAfterSeconds: SECONDARY_LIMIT_WAIT_SECONDS };
}

const ACCEPTED_NAMES: Readonly<Record<string, PermissionName>> = {
  contents: 'contents',
  pull_requests: 'pulls',
  statuses: 'statuses',
  metadata: 'metadata',
};

/** `x-accepted-github-permissions: contents=write; pull_requests=write` → 처음 알아보는 권한. */
function acceptedPermission(header: string | null): PermissionName | undefined {
  for (const part of (header ?? '').split(/[;,]/)) {
    const name = ACCEPTED_NAMES[part.split('=')[0]?.trim() ?? ''];
    if (name) return name;
  }
  return undefined;
}

const PERMISSION_NAMES: readonly PermissionName[] = ['metadata', 'contents', 'pulls', 'statuses'];

/** 권한 상태를 바꾸는 사건. `applyEvidence`만 이것을 반영한다. */
type Evidence =
  | { kind: 'write'; generation: number; permission: PermissionName; state: 'verified' | 'missing' }
  | { kind: 'snapshot'; generations: readonly number[]; seq: number; next: Permissions };

/** 반영된 권한 상태에 맞춰 연결 확인 결과의 ok·경고·이유를 다시 맞춘다(확인 도중 생긴 쓰기 결과 반영). */
function reconcileStatus(status: ConnectionStatus, merged: Permissions): ConnectionStatus {
  if (status.permissions === null) return status;
  const next: ConnectionStatus = { ...status, permissions: merged };
  const writes = ['contents', 'pulls', 'statuses'] as const;
  const missing = writes.filter((name) => merged[name] === 'missing');
  if (missing.length > 0 && status.ok) {
    next.ok = false;
    next.error = `쓰기 권한 부족(실제 쓰기 403): ${missing.join(', ')}`;
  }
  if (!writes.some((name) => merged[name] === 'unverified')) delete next.warning;
  if (!next.ok) delete next.warning;
  return next;
}

const unverifiedAll = (): Permissions => ({
  metadata: 'unverified',
  contents: 'unverified',
  pulls: 'unverified',
  statuses: 'unverified',
});

const SECONDARY_LIMIT_WAIT_SECONDS = 60;

/** status 목록을 읽을 최대 페이지. 100개×50 = 5000개(한 SHA·context 상한 1000개 × context 4종을 넘는다). */
const MAX_STATUS_PAGES = 50;

export function createGitHubClient(options: GitHubClientOptions) {
  const { repo, token, baseUrl = 'https://api.github.com', fetch: send = fetch, timeoutMs = 30_000 } = options;
  const beforeWrite = options.beforeWrite ?? (() => Promise.resolve());
  const repoPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  let redact = createRedactor();
  let permissions = unverifiedAll();
  // 권한 세대: 연결 확인을 시작할 때, 그리고 요청에 쓰는 토큰이 바뀐 것을 관측할 때 올린다.
  let generation = 0;
  let lastTokenDigest: string | undefined;
  // 통신 실패로 Raw가 없을 때도 그 요청을 보낸 세대를 알 수 있게 한다.
  const errorGeneration = new WeakMap<object, number>();
  // 연결 확인 순번. 겹치면 나중에 시작한 확인만 반영한다.
  let checkSeq = 0;
  // 권한마다 마지막 실제 쓰기 증거가 「어느 세대에서 보낸 요청」의 결과인지 기억한다.
  // 세대는 요청 시작 때(토큰을 받아 보내는 순간) 정해진다(Raw.generation). 어느 토큰·어느 확인 이후의 증거인지를 이것으로 가린다.
  const writeGeneration: Record<PermissionName, number> = { metadata: -1, contents: -1, pulls: -1, statuses: -1 };

  /**
   * 권한 상태를 바꾸는 **유일한** 함수. 동기 함수라 사건은 하나씩 차례로(직렬화되어) 반영된다.
   *
   * 규칙
   * 1. 현재 세대가 아닌 요청에서 나온 사건은 버린다(옛 토큰·옛 연결 확인 이전에 보낸 요청).
   * 2. 연결 확인 snapshot은 가장 최근에 시작한 확인일 때만 반영한다.
   * 3. 우선순위: 실제 쓰기 결과 > 연결 확인 snapshot.
   *    snapshot을 반영할 때, **지금 세대에서 보낸** 실제 쓰기 결과는 권한별로 그대로 둔다.
   *    연결 확인을 시작하면 새 세대가 열리므로 「지금 세대」 = 「이 확인이 시작된 뒤 + 지금 토큰으로 보낸 요청」이다.
   *    확인 시작 전의 쓰기 결과(재확인 = 새 판단), 그리고 그 사이 토큰이 바뀌어 다른 세대가 된 쓰기 결과(R14)는 snapshot으로 바뀐다.
   */
  const applyEvidence = (evidence: Evidence): { applied: boolean; permissions: Permissions } => {
    const result = (applied: boolean) => ({ applied, permissions: { ...permissions } });
    if (evidence.kind === 'write') {
      if (evidence.generation !== generation) return result(false);
      permissions[evidence.permission] = evidence.state;
      writeGeneration[evidence.permission] = evidence.generation;
      return result(true);
    }
    if (evidence.seq !== checkSeq || evidence.generations.some((sent) => sent !== generation)) return result(false);
    const merged = { ...evidence.next };
    for (const name of PERMISSION_NAMES) {
      if (writeGeneration[name] === generation) merged[name] = permissions[name];
    }
    permissions = merged;
    return result(true);
  };

  /**
   * 실제 쓰기 결과를 사건으로 만든다. 2xx면 확인됨, 속도 제한이 아닌 403이면 부족(+ 알림).
   * 409·405·422 같은 다른 거부는 권한에 대한 증거가 아니므로 사건을 만들지 않는다.
   */
  const observeWrite = (raw: Raw, permission: PermissionName, operation: WriteOperation['kind'], what: string): void => {
    if (raw.status >= 200 && raw.status < 300) {
      applyEvidence({ kind: 'write', generation: raw.generation, permission, state: 'verified' });
      return;
    }
    if (raw.status !== 403 || rateLimit(raw).limited) return;
    const denied = acceptedPermission(raw.headers.get('x-accepted-github-permissions')) ?? permission;
    const { applied } = applyEvidence({ kind: 'write', generation: raw.generation, permission: denied, state: 'missing' });
    const notify = options.onPermissionDenied;
    // 반영되지 않은(옛 세대) 403은 알리지 않는다.
    if (!applied || !notify) return;
    // 알림 실패(동기 예외·비동기 거부 모두)가 원래 오류를 가리거나 Runner를 종료시키지 않게 한다.
    void Promise.resolve()
      .then(() => notify({ permission: denied, operation, message: failure(raw, what).message }))
      .catch(() => undefined);
  };

  const failure = (raw: Raw, what: string): GitHubError => {
    const message = (raw.body as { message?: unknown } | undefined)?.message;
    const text = redact(`${what}: ${String(raw.status)} ${typeof message === 'string' ? message : ''}`.trim());
    const limit = rateLimit(raw);
    return new GitHubError(text, raw.status, raw.status >= 500 || limit.limited, limit.retryAfterSeconds);
  };

  /** 응답 상태와 관계없이 돌려준다. 통신 실패만 던진다. */
  const call = async (method: string, path: string, init: { query?: Record<string, string>; body?: unknown } = {}): Promise<Raw> => {
    const secret = await token();
    redact = createRedactor([secret.reveal()]);
    const digest = createHash('sha256').update(secret.reveal()).digest('hex');
    if (lastTokenDigest !== undefined && digest !== lastTokenDigest) generation += 1;
    lastTokenDigest = digest;
    const sentAt = generation;
    const url = new URL(baseUrl.replace(/\/+$/, '') + path);
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
    const headers = new Headers({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${secret.reveal()}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agent-wbs-runner',
    });
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    try {
      const response = await send(url, {
        method,
        headers,
        body: init.body === undefined ? null : JSON.stringify(init.body),
        // 토큰을 다른 주소로 보내지 않는다.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, body, headers: response.headers, generation: sentAt };
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'Error';
      const failed = new GitHubError(`${method} ${path}: 통신 실패(${reason})`, 0, true);
      errorGeneration.set(failed, sentAt);
      throw failed;
    }
  };

  const ok = async <T>(method: string, path: string, init: Parameters<typeof call>[2] = {}, expected = [200]): Promise<T> => {
    const raw = await call(method, path, init);
    if (!expected.includes(raw.status)) throw failure(raw, `${method} ${path}`);
    return raw.body as T;
  };

  const findOpenPull = async (branch: string): Promise<PullRequest | undefined> => {
    const list = await ok<PullJson[]>('GET', `${repoPath}/pulls`, {
      query: { head: `${repo.owner}:${branch}`, state: 'open', base: 'main' },
    });
    const found = list.find((pull) => pull.head.ref === branch);
    return found ? toPull(found) : undefined;
  };

  const getPullRequest = async (pr: number): Promise<PullRequest> =>
    toPull(await ok<PullJson>('GET', `${repoPath}/pulls/${String(pr)}`));

  const commitOf = (sha: string) =>
    ok<{ sha: string; tree: { sha: string }; parents: { sha: string }[] }>('GET', `${repoPath}/git/commits/${sha}`);

  /** contracts §4.1-3-6: 병합 커밋의 부모가 [A, H′]이고 tree가 H′의 tree인지 확인한다. */
  const verifyMerge = async (mergeSha: string, baseSha: string, headSha: string, reconciled: boolean): Promise<MergeOutcome> => {
    const extra = reconciled ? { reconciled: true as const } : {};
    let merge: Awaited<ReturnType<typeof commitOf>>;
    let head: Awaited<ReturnType<typeof commitOf>>;
    try {
      [merge, head] = await Promise.all([commitOf(mergeSha), commitOf(headSha)]);
    } catch (error) {
      return {
        kind: 'unknown',
        observed: 'read_failed',
        error: redact(`병합 커밋 확인 실패: ${error instanceof Error ? error.message : String(error)}`),
      };
    }
    const parents = merge.parents.map((p) => p.sha);
    if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) {
      return { kind: 'verify_failed', mergeSha, reason: `병합 커밋 부모가 [A, H′]가 아님: ${parents.join(',')}`, ...extra };
    }
    if (merge.tree.sha !== head.tree.sha) {
      return { kind: 'verify_failed', mergeSha, reason: '병합 커밋 tree가 H′의 tree와 다름', ...extra };
    }
    return { kind: 'merged', mergeSha, treeSha: merge.tree.sha, ...extra };
  };

  const checkMergeInput = ({ pr, baseSha, headSha }: { pr: number; baseSha: string; headSha: string }) => {
    if (!Number.isSafeInteger(pr) || pr < 1) throw invalid('PR 번호가 올바르지 않습니다.');
    if (!SHA.test(baseSha) || !SHA.test(headSha)) throw invalid('A·H′는 40자리 소문자 SHA여야 합니다.');
    if (baseSha === headSha) throw invalid('H′가 A와 같으면 병합할 변경이 없습니다.');
  };

  /** 쓰기 없이 PR을 읽어 병합 결과를 대조한다. 병합이 보이지 않으면 확정하지 않고 unknown이다. */
  const reconcileMerge = async (pr: number, baseSha: string, headSha: string): Promise<MergeOutcome> => {
    let pull: PullRequest;
    try {
      pull = await getPullRequest(pr);
    } catch (error) {
      return {
        kind: 'unknown',
        observed: 'read_failed',
        error: redact(`병합 대조 실패: ${error instanceof Error ? error.message : String(error)}`),
      };
    }
    if (!pull.merged) return { kind: 'unknown', observed: pull.state };
    if (!pull.mergeCommitSha) return { kind: 'unknown', observed: 'read_failed', error: '병합됐지만 병합 커밋 SHA가 없음' };
    return verifyMerge(pull.mergeCommitSha, baseSha, headSha, true);
  };

  /**
   * 연결 확인의 실제 판단. 공유 권한 상태는 건드리지 않고, 반영할 값(next)과 보고할 결과만 만든다.
   * 보낸 요청마다 세대를 generations에 모은다(늦은 응답 판별용).
   */
  const evaluateConnection = async (
    mode: GithubMode,
    generations: number[],
  ): Promise<{ status: ConnectionStatus; next: Permissions }> => {
    const next = unverifiedAll();
    const fail = (error: string, rest: Partial<ConnectionStatus> = {}) => ({
      status: { mode, ok: false, account: null, permissions: null, expiresAt: null, ...rest, error } satisfies ConnectionStatus,
      next,
    });
    const get = async (path: string): Promise<Raw> => {
      try {
        const raw = await call('GET', path);
        generations.push(raw.generation);
        return raw;
      } catch (error) {
        // 토큰 취득 실패는 요청을 보내지 못한 것이라 세대가 없다. 현재 확인의 실패로 다룬다(R12).
        const sent = errorGeneration.get(error as object);
        if (sent !== undefined) generations.push(sent);
        throw error;
      }
    };
    let user: Raw;
    try {
      user = await get('/user');
    } catch (error) {
      return fail(error instanceof Error ? error.message : '통신 실패');
    }
    if (user.status === 401) return fail('인증 실패(401): 토큰이 틀렸거나 만료·폐기됨');
    if (rateLimit(user).limited) return fail(`GitHub 속도 제한: 잠시 뒤 다시 확인 (${failure(user, 'GET /user').message})`);
    if (user.status !== 200) return fail(failure(user, 'GET /user').message);
    const account = (user.body as { login?: string }).login ?? null;
    const expiresAt = parseExpiration(user.headers.get('github-authentication-token-expiration'));
    let repository: Raw;
    try {
      repository = await get(repoPath);
    } catch (error) {
      return fail(error instanceof Error ? error.message : '통신 실패', { account, expiresAt });
    }
    if (rateLimit(repository).limited) {
      return fail(`GitHub 속도 제한: 잠시 뒤 다시 확인 (${failure(repository, 'GET 저장소').message})`, { account, expiresAt });
    }
    if (repository.status !== 200) {
      return fail(`저장소에 접근할 수 없음(${String(repository.status)})`, { account, expiresAt });
    }
    const repoPermissions = (repository.body as { permissions?: { admin?: boolean; push?: boolean; pull?: boolean } }).permissions ?? {};
    if (repoPermissions.admin === true) {
      return fail('관리자 권한 자격 증명은 쓰지 않음(보호 규칙 우회 가능). 관리자가 아닌 별도 계정/앱 필요', { account, expiresAt });
    }
    // 저장소를 읽었으므로 Metadata 읽기는 확인됐다.
    next.metadata = 'verified';
    const writes = ['contents', 'pulls', 'statuses'] as const;
    const base = { mode, account, expiresAt };
    const oauth = user.headers.get('x-oauth-scopes');
    if (oauth !== null) {
      // classic 토큰·gh OAuth 토큰: `repo` 범위가 쓰기 권한 셋을 모두 포함한다(OAuth scopes 문서).
      const has = oauth.split(',').map((scope) => scope.trim()).includes('repo');
      for (const name of writes) next[name] = has ? 'verified' : 'missing';
      if (!has) {
        return { status: { ...base, ok: false, permissions: { ...next }, error: '필요한 권한 부족: contents, pulls, statuses (repo 범위 없음)' }, next };
      }
      return { status: { ...base, ok: true, permissions: { ...next } }, next };
    }
    // fine-grained 토큰: 토큰에 부여된 권한 목록을 조회하는 API가 없다(README §4).
    // 계정이 push할 수 없으면 토큰도 쓸 수 없으므로 부족이다. 그 밖에는 추정하지 않고 미확인으로 두고 실행은 허용한다.
    if (repoPermissions.push !== true) {
      for (const name of writes) next[name] = 'missing';
      return { status: { ...base, ok: false, permissions: { ...next }, error: '쓰기 권한 부족: 이 계정은 저장소에 push할 수 없음' }, next };
    }
    return {
      status: {
        ...base,
        ok: true,
        permissions: { ...next },
        warning:
          '쓰기 권한(Contents·Pull requests·Commit statuses) 미확인: fine-grained 토큰은 부여된 권한을 조회할 수 없어 첫 쓰기에서 확인함(M4-06 실증 항목)',
      },
      next,
    };
  };

  return {
    repo,

    /** 지금까지 알게 된 권한 상태(연결 확인 + 실제 쓰기 결과). 복사본을 돌려준다. */
    permissions(): Permissions {
      return { ...permissions };
    },

    /** 설정의 「연결 확인」. 던지지 않고 실패를 `ok:false`로 돌려준다. */
    async checkConnection(mode: GithubMode): Promise<ConnectionStatus> {
      // 새 연결 확인은 새로 판단한다(토큰을 고친 뒤 다시 확인하는 경우). 세대를 올려 진행 중인 옛 응답이 상태를 못 바꾸게 한다.
      generation += 1;
      checkSeq += 1;
      const seq = checkSeq;
      const generations: number[] = [];
      const { status, next } = await evaluateConnection(mode, generations);
      const applied = applyEvidence({ kind: 'snapshot', generations, seq, next });
      if (applied.applied) return reconcileStatus(status, applied.permissions);
      const rest: ConnectionStatus = { ...status };
      delete rest.warning;
      return {
        ...rest,
        ok: false,
        superseded: true,
        error: `더 새로운 연결 확인 또는 토큰 교체로 무효화된 결과${status.error ? ` (${status.error})` : ''}`,
      };
    },

    /** 프로젝트 등록의 「저장소 접근 확인」(G L233). 일시 장애(재시도 가능)는 던진다. */
    async checkRepository(): Promise<RepositoryCheck> {
      const repository = await call('GET', repoPath);
      // 속도 제한 403은 접근 불가가 아니다. 재시도할 수 있게 던진다.
      if (rateLimit(repository).limited) throw failure(repository, 'GET 저장소');
      if ([401, 403, 404].includes(repository.status)) {
        return { access: false, private: null, commit: null, structure: null, error: failure(repository, 'GET 저장소').message };
      }
      if (repository.status !== 200) throw failure(repository, 'GET 저장소');
      const isPrivate = (repository.body as { private?: boolean }).private ?? null;
      const branch = await call('GET', `${repoPath}/branches/main`);
      if (branch.status === 404) return { access: true, private: isPrivate, commit: null, structure: null };
      if (branch.status !== 200) throw failure(branch, 'GET main');
      const commit = (branch.body as { commit: { sha: string } }).commit.sha;
      const tree = await ok<{ truncated: boolean; tree: { path: string; type: string }[] }>(
        'GET',
        `${repoPath}/git/trees/${commit}`,
        { query: { recursive: '1' } },
      );
      if (tree.truncated) {
        return { access: true, private: isPrivate, commit, structure: null, error: '트리 응답이 잘림(truncated): 구조를 확인하지 못함' };
      }
      const blobs = tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
      const under = (prefix: string) => blobs.filter((path) => path.startsWith(prefix));
      const uiuxFiles = under('prototype/uiux/').length;
      return {
        access: true,
        private: isPrivate,
        commit,
        structure: {
          uiux: uiuxFiles > 0,
          uiuxFiles,
          docs: under('prototype/docs/').filter((path) => path.toLowerCase().endsWith('.md')).sort(),
          src: under('src/').length > 0,
          contracts: under('contracts/').length > 0,
          agentwbs: under('.agentwbs/').length > 0,
        },
      };
    },

    /** Task 브랜치의 열린 PR을 돌려주거나 새로 만든다. 재시도해도 PR이 둘 생기지 않는다. */
    async ensurePullRequest(input: { branch: string; title: string; body: string }): Promise<PullRequest & { created: boolean }> {
      if (!BRANCH.test(input.branch)) throw invalid('PR 브랜치는 agent/<TASK> 형식이어야 합니다.');
      const existing = await findOpenPull(input.branch);
      if (existing) return { ...existing, created: false };
      await beforeWrite({ kind: 'pull_create', branch: input.branch });
      const raw = await call('POST', `${repoPath}/pulls`, {
        body: { title: input.title, head: input.branch, base: 'main', body: input.body },
      });
      observeWrite(raw, 'pulls', 'pull_create', 'POST PR');
      if (raw.status === 201) return { ...toPull(raw.body as PullJson), created: true };
      if (raw.status === 422) {
        // 조회와 생성 사이에 다른 호출이 만들었다(응답 유실 뒤 재시도 등).
        const raced = await findOpenPull(input.branch);
        if (raced) return { ...raced, created: false };
      }
      throw failure(raw, 'POST PR');
    },

    getPullRequest,

    async closePullRequest(pr: number): Promise<void> {
      if (!Number.isSafeInteger(pr) || pr < 1) throw invalid('PR 번호가 올바르지 않습니다.');
      await beforeWrite({ kind: 'pull_close', pr });
      const raw = await call('PATCH', `${repoPath}/pulls/${String(pr)}`, { body: { state: 'closed' } });
      observeWrite(raw, 'pulls', 'pull_close', 'PATCH PR');
      if (raw.status !== 200) throw failure(raw, 'PATCH PR');
    },

    /**
     * 이 시스템이 기록한 원격 Agent 브랜치를 지운다(초기화 2단계, contracts §6). `agent/…`만 받는다. Contents 쓰기 권한의 증거다.
     *
     * 성공은 204뿐이다(GitHub REST 「Delete a reference」).
     * 422는 「검증 실패·기본 브랜치 삭제 시도·요청 남발」, 409는 「충돌」이라 **브랜치가 없다는 증거가 아니다.**
     * 그래서 204가 아니면 `GET /git/ref/heads/<branch>`로 다시 확인한다. 404(참조 없음)일 때만 이미 지워진 것으로 본다.
     * 왜: 거절을 성공으로 바꾸면 브랜치가 남았는데 정리 완료를 보고하게 된다(재리뷰 N3).
     */
    async deleteBranch(branch: string): Promise<void> {
      if (!BRANCH.test(branch)) throw invalid('Agent 브랜치(agent/<TASK>)만 지울 수 있습니다.');
      const ref = `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
      await beforeWrite({ kind: 'branch_delete', branch });
      const raw = await call('DELETE', `${repoPath}/git/refs/${ref}`);
      observeWrite(raw, 'contents', 'branch_delete', 'DELETE ref');
      if (raw.status === 204) return;
      const check = await call('GET', `${repoPath}/git/ref/${ref}`);
      if (check.status === 404) return;
      throw failure(raw, 'DELETE ref');
    },

    /** 원격 main의 SHA. 저장소가 비었으면 null. */
    async mainSha(): Promise<string | null> {
      const raw = await call('GET', `${repoPath}/branches/main`);
      if (raw.status === 404) return null;
      if (raw.status !== 200) throw failure(raw, 'GET main');
      return (raw.body as { commit: { sha: string } }).commit.sha;
    },

    /** 커밋의 최상위 항목 이름 → 객체 SHA. 초기화 대상(src·contracts·.agentwbs)이 기준과 같은지 비교할 때 쓴다(쓰기 없음). */
    async topLevelEntries(commit: string): Promise<Record<string, string>> {
      if (!SHA.test(commit)) throw invalid('commit SHA 형식이 올바르지 않습니다.');
      const tree = await ok<{ tree: { path: string; sha?: string }[] }>('GET', `${repoPath}/git/trees/${commit}`);
      const out: Record<string, string> = {};
      for (const entry of tree.tree) if (!entry.path.includes('/') && typeof entry.sha === 'string') out[entry.path] = entry.sha;
      return out;
    },

    async setCommitStatus(input: {
      sha: string;
      context: StatusContext;
      state: StatusState;
      description?: string;
      targetUrl?: string;
    }): Promise<void> {
      if (!SHA.test(input.sha)) throw invalid('commit SHA 형식이 올바르지 않습니다.');
      if (!CONTEXTS.includes(input.context)) throw invalid('허용되지 않은 status context입니다.');
      if (!STATES.includes(input.state)) throw invalid('허용되지 않은 status state입니다.');
      const body: Record<string, string> = { state: input.state, context: input.context };
      if (input.targetUrl !== undefined) body.target_url = input.targetUrl;
      await beforeWrite({ kind: 'status', sha: input.sha, context: input.context });
      if (input.description !== undefined) {
        // 비밀값(현재 토큰 포함)을 먼저 가린 뒤 자른다. 자르면서 패턴이 깨져 일부가 남지 않게 하기 위해서다.
        const secret = await token();
        body.description = truncate(createRedactor([secret.reveal()])(input.description), DESCRIPTION_MAX);
      }
      const raw = await call('POST', `${repoPath}/statuses/${input.sha}`, { body });
      observeWrite(raw, 'statuses', 'status', 'POST status');
      if (raw.status !== 201) throw failure(raw, 'POST status');
    },

    async listCommitStatuses(sha: string): Promise<CommitStatus[]> {
      if (!SHA.test(sha)) throw invalid('commit SHA 형식이 올바르지 않습니다.');
      const list: StatusJson[] = [];
      // Link 헤더의 주소를 그대로 따라가지 않는다(토큰을 다른 주소로 보내지 않게). 같은 경로에서 page만 올린다.
      for (let page = 1; ; page += 1) {
        if (page > MAX_STATUS_PAGES) {
          throw new GitHubError(`status가 ${String(MAX_STATUS_PAGES)}페이지를 넘어 모두 읽지 못함`, -1, false);
        }
        const raw = await call('GET', `${repoPath}/commits/${sha}/statuses`, {
          query: { per_page: '100', page: String(page) },
        });
        if (raw.status !== 200) throw failure(raw, 'GET statuses');
        const items = raw.body as StatusJson[];
        list.push(...items);
        if (!/rel="next"/.test(raw.headers.get('link') ?? '') || items.length === 0) break;
      }
      return list.map((s) => ({ context: s.context, state: s.state, description: s.description, targetUrl: s.target_url }));
    },

    /**
     * contracts §4.1 코드 근거 고정 3-5·6. 병합 경로는 이것 하나다.
     * `baseSha`=A(대기열이 고정한 main), `headSha`=H′(②를 통과하고 int를 게시한 PR head).
     */
    async mergePullRequest(input: { pr: number; baseSha: string; headSha: string }): Promise<MergeOutcome> {
      const { pr, baseSha, headSha } = input;
      checkMergeInput(input);
      await beforeWrite({ kind: 'merge', pr, headSha });
      let raw: Raw;
      try {
        raw = await call('PUT', `${repoPath}/pulls/${String(pr)}/merge`, { body: { sha: headSha, merge_method: 'merge' } });
      } catch {
        return reconcileMerge(pr, baseSha, headSha);
      }
      observeWrite(raw, 'contents', 'merge', 'PUT merge');
      const message = redact(String((raw.body as { message?: unknown } | undefined)?.message ?? ''));
      if (raw.status === 200) {
        const mergeSha = (raw.body as { sha?: unknown } | undefined)?.sha;
        if (typeof mergeSha !== 'string' || !SHA.test(mergeSha)) return reconcileMerge(pr, baseSha, headSha);
        return verifyMerge(mergeSha, baseSha, headSha, false);
      }
      if (raw.status === 409) return { kind: 'head_changed', status: 409, message };
      if (raw.status === 405) return { kind: 'rejected', status: 405, message };
      if (raw.status >= 500) return reconcileMerge(pr, baseSha, headSha);
      throw failure(raw, 'PUT merge');
    },

    /**
     * 병합 결과를 **쓰기 없이** 다시 대조한다. `unknown`이었던 병합을 해소할 때 쓴다(contracts §3.4-6).
     * 병합이 보이면 merged/verify_failed, 아직 안 보이면 다시 unknown이다. 횟수·시간이 찼다고 「효과 없음」을 확정하지 않는다.
     */
    async reconcileMerge(input: { pr: number; baseSha: string; headSha: string }): Promise<MergeOutcome> {
      checkMergeInput(input);
      return reconcileMerge(input.pr, input.baseSha, input.headSha);
    },
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
