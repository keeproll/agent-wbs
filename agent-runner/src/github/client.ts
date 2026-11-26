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
  | { kind: 'status'; sha: string; context: StatusContext }
  | { kind: 'merge'; pr: number; headSha: string };

export interface GitHubClientOptions {
  repo: RepoRef;
  /** 요청마다 부른다. 봉인 값을 연 `Secret`이나 `gh auth token` 결과를 돌려준다. */
  token: () => Promise<Secret>;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** 거부(throw)하면 GitHub를 호출하지 않는다. 예: 409 EXTERNAL_WRITE_BLOCKED. */
  beforeWrite?: (operation: WriteOperation) => Promise<void>;
  timeoutMs?: number;
}

/** `reportGithubStatus` 본문과 같은 모양(비밀값 없음). */
export interface ConnectionStatus {
  mode: GithubMode;
  ok: boolean;
  account: string | null;
  scopes: { contents: boolean; pulls: boolean; statuses: boolean; metadata: boolean } | null;
  expiresAt: string | null;
  error?: string;
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
  /** 응답 유실 뒤 대조해 보니 병합되지 않았다. */
  | { kind: 'not_merged'; reconciled: true }
  /** 응답도 대조도 실패했다. 결과를 모른다. */
  | { kind: 'unknown'; error: string };

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

interface Raw {
  status: number;
  body: unknown;
  headers: Headers;
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

export function createGitHubClient(options: GitHubClientOptions) {
  const { repo, token, baseUrl = 'https://api.github.com', fetch: send = fetch, timeoutMs = 30_000 } = options;
  const beforeWrite = options.beforeWrite ?? (() => Promise.resolve());
  const repoPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  let redact = createRedactor();

  const failure = (raw: Raw, what: string): GitHubError => {
    const message = (raw.body as { message?: unknown } | undefined)?.message;
    const text = redact(`${what}: ${String(raw.status)} ${typeof message === 'string' ? message : ''}`.trim());
    const retryAfter = Number(raw.headers.get('retry-after'));
    const rateLimited = raw.status === 429 || (raw.status === 403 && raw.headers.get('x-ratelimit-remaining') === '0');
    return new GitHubError(
      text,
      raw.status,
      raw.status >= 500 || rateLimited,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  };

  /** 응답 상태와 관계없이 돌려준다. 통신 실패만 던진다. */
  const call = async (method: string, path: string, init: { query?: Record<string, string>; body?: unknown } = {}): Promise<Raw> => {
    const secret = await token();
    redact = createRedactor([secret.reveal()]);
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
      return { status: response.status, body, headers: response.headers };
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'Error';
      throw new GitHubError(`${method} ${path}: 통신 실패(${reason})`, 0, true);
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
      return { kind: 'unknown', error: redact(`병합 커밋 확인 실패: ${error instanceof Error ? error.message : String(error)}`) };
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

  const reconcileMerge = async (pr: number, baseSha: string, headSha: string): Promise<MergeOutcome> => {
    let pull: PullRequest;
    try {
      pull = await getPullRequest(pr);
    } catch (error) {
      return { kind: 'unknown', error: redact(`병합 대조 실패: ${error instanceof Error ? error.message : String(error)}`) };
    }
    if (!pull.merged) return { kind: 'not_merged', reconciled: true };
    if (!pull.mergeCommitSha) return { kind: 'unknown', error: '병합됐지만 병합 커밋 SHA가 없음' };
    return verifyMerge(pull.mergeCommitSha, baseSha, headSha, true);
  };

  return {
    repo,

    /** 설정의 「연결 확인」. 던지지 않고 실패를 `ok:false`로 돌려준다. */
    async checkConnection(mode: GithubMode): Promise<ConnectionStatus> {
      const fail = (error: string, rest: Partial<ConnectionStatus> = {}): ConnectionStatus => ({
        mode,
        ok: false,
        account: null,
        scopes: null,
        expiresAt: null,
        ...rest,
        error,
      });
      let user: Raw;
      try {
        user = await call('GET', '/user');
      } catch (error) {
        return fail(error instanceof Error ? error.message : '통신 실패');
      }
      if (user.status === 401) return fail('인증 실패(401): 토큰이 틀렸거나 만료·폐기됨');
      if (user.status !== 200) return fail(failure(user, 'GET /user').message);
      const account = (user.body as { login?: string }).login ?? null;
      const expiresAt = parseExpiration(user.headers.get('github-authentication-token-expiration'));
      let repository: Raw;
      try {
        repository = await call('GET', repoPath);
      } catch (error) {
        return fail(error instanceof Error ? error.message : '통신 실패', { account, expiresAt });
      }
      if (repository.status !== 200) {
        return fail(`저장소에 접근할 수 없음(${String(repository.status)})`, { account, expiresAt });
      }
      const permissions = (repository.body as { permissions?: { admin?: boolean; push?: boolean; pull?: boolean } }).permissions ?? {};
      const oauth = user.headers.get('x-oauth-scopes');
      let scopes: NonNullable<ConnectionStatus['scopes']>;
      if (oauth !== null) {
        // classic 토큰·gh OAuth 토큰: `repo` 범위가 네 권한을 모두 포함한다.
        const has = oauth.split(',').map((s) => s.trim()).includes('repo');
        scopes = { contents: has, pulls: has, statuses: has, metadata: has };
      } else {
        // fine-grained 토큰은 토큰 권한을 직접 조회하는 API가 없어 저장소 권한으로 추정한다(M4-06 실증 대상).
        const push = permissions.push === true;
        scopes = { contents: push, pulls: push, statuses: push, metadata: permissions.pull === true };
      }
      const missing = Object.entries(scopes)
        .filter(([, value]) => !value)
        .map(([name]) => name);
      const base = { mode, account, scopes, expiresAt };
      if (missing.length > 0) return { ...base, ok: false, error: `필요한 권한 부족: ${missing.join(', ')}` };
      if (permissions.admin === true) {
        return { ...base, ok: false, error: '관리자 권한 자격 증명은 쓰지 않음(보호 규칙 우회 가능). 관리자가 아닌 별도 계정/앱 필요' };
      }
      return { ...base, ok: true };
    },

    /** 프로젝트 등록의 「저장소 접근 확인」(G L233). 일시 장애(재시도 가능)는 던진다. */
    async checkRepository(): Promise<RepositoryCheck> {
      const repository = await call('GET', repoPath);
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
      await ok('PATCH', `${repoPath}/pulls/${String(pr)}`, { body: { state: 'closed' } });
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
      await ok('POST', `${repoPath}/statuses/${input.sha}`, { body }, [201]);
    },

    async listCommitStatuses(sha: string): Promise<CommitStatus[]> {
      if (!SHA.test(sha)) throw invalid('commit SHA 형식이 올바르지 않습니다.');
      const list = await ok<{ context: string; state: string; description: string | null; target_url: string | null }[]>(
        'GET',
        `${repoPath}/commits/${sha}/statuses`,
        { query: { per_page: '100' } },
      );
      return list.map((s) => ({ context: s.context, state: s.state, description: s.description, targetUrl: s.target_url }));
    },

    /**
     * contracts §4.1 코드 근거 고정 3-5·6. 병합 경로는 이것 하나다.
     * `baseSha`=A(대기열이 고정한 main), `headSha`=H′(②를 통과하고 int를 게시한 PR head).
     */
    async mergePullRequest(input: { pr: number; baseSha: string; headSha: string }): Promise<MergeOutcome> {
      const { pr, baseSha, headSha } = input;
      if (!Number.isSafeInteger(pr) || pr < 1) throw invalid('PR 번호가 올바르지 않습니다.');
      if (!SHA.test(baseSha) || !SHA.test(headSha)) throw invalid('A·H′는 40자리 소문자 SHA여야 합니다.');
      if (baseSha === headSha) throw invalid('H′가 A와 같으면 병합할 변경이 없습니다.');
      await beforeWrite({ kind: 'merge', pr, headSha });
      let raw: Raw;
      try {
        raw = await call('PUT', `${repoPath}/pulls/${String(pr)}/merge`, { body: { sha: headSha, merge_method: 'merge' } });
      } catch {
        return reconcileMerge(pr, baseSha, headSha);
      }
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
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
