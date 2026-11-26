import { createHash } from 'node:crypto';
import type { FakeGitHub, FakeRequest, FakeResponse } from './server.ts';

/**
 * 가짜 GitHub 저장소 1개의 상태와 규칙.
 *
 * 실제 GitHub 문서(contracts §4.1 근거 링크)의 다음 동작만 흉내 낸다.
 * - `PUT /pulls/{n}/merge`: `sha`가 PR head와 다르면 409.
 * - strict up-to-date 보호: head가 main 끝을 포함하지 않거나 필수 status가 head에서 success가 아니면 405.
 * - 병합 커밋의 부모는 [main, head], tree는 head의 tree(head가 main을 포함하므로).
 * 실제 응답 문구·필드 전체를 재현하지 않는다. 실환경 대조는 M4-06에서 한다.
 */
export interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
}

export interface FakeStatus {
  state: string;
  context: string;
  description: string | null;
  target_url: string | null;
}

export interface ModelOptions {
  owner?: string;
  repo?: string;
  private?: boolean;
  /** 처음 main에 둘 파일 경로. 빈 배열이면 커밋 없는 새 저장소. */
  files?: string[];
  login?: string;
  /** classic 토큰처럼 `x-oauth-scopes` 헤더를 줄 때 값. */
  oauthScopes?: string;
  /** `github-authentication-token-expiration` 헤더 값. */
  tokenExpiration?: string;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
  requiredContexts?: string[];
  strict?: boolean;
  /** 트리 응답을 truncated로 준다. */
  truncatedTree?: boolean;
  /**
   * fine-grained 토큰처럼 엔드포인트마다 따로 주는 권한. 없으면 모두 write.
   * 실제 GitHub는 PR 생성·닫기에 Pull requests 쓰기, status 게시에 Commit statuses 쓰기,
   * PR 병합에 Contents 쓰기를 요구한다(README의 권한 근거 표).
   */
  tokenPermissions?: Partial<Record<Permission, 'none' | 'read' | 'write'>>;
}

export type Permission = 'contents' | 'pulls' | 'statuses';
export type RateLimitKind = 'primary' | 'secondary' | 'secondary429';

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

export class GitHubModel {
  readonly owner: string;
  readonly repo: string;
  readonly isPrivate: boolean;
  readonly commits = new Map<string, FakeCommit>();
  readonly trees = new Map<string, string[]>();
  readonly branches = new Map<string, string>();
  readonly pulls = new Map<number, FakePull>();
  readonly statuses = new Map<string, FakeStatus[]>();
  readonly options: ModelOptions;
  /** 다음 병합 요청을 처리한 뒤 응답을 잃는다. */
  dropNextMerge = false;
  /** M4-06 실측: head 갱신 뒤 병합 가능 여부 계산 중에는 sha 검사보다 먼저 405가 올 수 있다. */
  mergeabilityPending = false;
  /** 병합 커밋을 일부러 잘못 만든다(부모·tree 검증 시험용). */
  corruptMerge: 'parents' | 'tree' | null = null;
  /** 병합 후 이만큼의 PR 조회는 병합 전 모습을 돌려준다(조회 반영 지연). */
  pullReadLag = 0;
  #stale: { number: number; json: ReturnType<GitHubModel['pullJson']>; left: number } | null = null;
  #mergeGate: Promise<undefined> | null = null;
  #limit: { left: number; kind: RateLimitKind } | null = null;
  #seq = 0;

  /**
   * 병합 요청을 받아 두기만 하고 release() 전까지 적용하지 않는다.
   * 클라이언트가 타임아웃으로 떠난 뒤에도 원래 요청이 늦게 적용되는 실제 순서를 흉내 낸다.
   */
  holdMerges(): () => void {
    const gate = Promise.withResolvers<undefined>();
    this.#mergeGate = gate.promise;
    return () => {
      this.#mergeGate = null;
      gate.resolve(undefined);
    };
  }

  /** 다음 count개 요청을 속도 제한으로 거부한다. */
  limitNext(count: number, kind: RateLimitKind): void {
    this.#limit = { left: count, kind };
  }

  #rateLimited(): FakeResponse | undefined {
    if (!this.#limit || this.#limit.left <= 0) return undefined;
    this.#limit.left -= 1;
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    switch (this.#limit.kind) {
      case 'primary':
        return {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
          body: { message: 'API rate limit exceeded for user ID 1.' },
        };
      case 'secondary':
        return {
          status: 403,
          headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': reset },
          body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        };
      case 'secondary429':
        return { status: 429, headers: { 'retry-after': '30' }, body: { message: 'You have exceeded a secondary rate limit.' } };
    }
  }

  constructor(options: ModelOptions = {}) {
    this.options = options;
    this.owner = options.owner ?? 'o';
    this.repo = options.repo ?? 'r';
    this.isPrivate = options.private ?? true;
    const files = options.files ?? ['README.md'];
    if (files.length > 0) this.branches.set('main', this.#commit([], files));
  }

  #commit(parents: string[], files: string[]): string {
    this.#seq += 1;
    const tree = sha1(`tree:${files.join('\n')}:${String(this.#seq)}`);
    this.trees.set(tree, [...files]);
    const sha = sha1(`commit:${String(this.#seq)}:${parents.join(',')}`);
    this.commits.set(sha, { sha, tree, parents });
    return sha;
  }

  filesOf(sha: string): string[] {
    const commit = this.commits.get(sha);
    return commit ? (this.trees.get(commit.tree) ?? []) : [];
  }

  /** 브랜치에 새 커밋을 올린다(없으면 main에서 만든다). */
  push(branch: string, extra: string[] = [`${branch}-${String(this.#seq + 1)}.txt`]): string {
    const tip = this.branches.get(branch) ?? this.branches.get('main');
    const parents = tip ? [tip] : [];
    const sha = this.#commit(parents, [...(tip ? this.filesOf(tip) : []), ...extra]);
    this.branches.set(branch, sha);
    return sha;
  }

  /** main을 PR 브랜치에 병합해 H'를 만든다(Runner 동기화 흉내). */
  syncWithMain(branch: string): string {
    const head = this.branches.get(branch);
    const main = this.branches.get('main');
    if (!head || !main) throw new Error('브랜치 없음');
    const files = [...new Set([...this.filesOf(head), ...this.filesOf(main)])];
    const sha = this.#commit([head, main], files);
    this.branches.set(branch, sha);
    return sha;
  }

  contains(descendant: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const sha = stack.pop() ?? '';
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      stack.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  openPull(branch: string, title = branch): FakePull {
    const pull: FakePull = {
      number: this.pulls.size + 1,
      title,
      body: '',
      head: branch,
      base: 'main',
      state: 'open',
      merged: false,
      mergeCommitSha: null,
    };
    this.pulls.set(pull.number, pull);
    return pull;
  }

  setStatus(sha: string, context: string, state: string): void {
    this.statuses.set(sha, [{ state, context, description: null, target_url: null }, ...(this.statuses.get(sha) ?? [])]);
  }

  latestState(sha: string, context: string): string | undefined {
    return this.statuses.get(sha)?.find((s) => s.context === context)?.state;
  }

  pullJson(pull: FakePull) {
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.head, sha: this.branches.get(pull.head) ?? null },
      base: { ref: pull.base, sha: this.branches.get(pull.base) ?? null },
      html_url: `https://github.com/${this.owner}/${this.repo}/pull/${String(pull.number)}`,
    };
  }

  merge(number: number, body: { sha?: string; merge_method?: string }): FakeResponse {
    const pull = this.pulls.get(number);
    if (!pull) return { status: 404, body: { message: 'Not Found' } };
    if (pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    if (this.mergeabilityPending) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    const head = this.branches.get(pull.head) ?? '';
    const main = this.branches.get(pull.base) ?? '';
    if (body.sha !== undefined && body.sha !== head) {
      return { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } };
    }
    if ((this.options.strict ?? true) && !this.contains(head, main)) {
      return { status: 405, body: { message: 'Head branch is out of date.' } };
    }
    for (const context of this.options.requiredContexts ?? ['agentwbs/int']) {
      if (this.latestState(head, context) !== 'success') {
        return { status: 405, body: { message: `Required status check "${context}" is expected.` } };
      }
    }
    if (body.merge_method !== undefined && body.merge_method !== 'merge') {
      return { status: 405, body: { message: 'Merge method not allowed in this test' } };
    }
    const parents = this.corruptMerge === 'parents' ? [head] : [main, head];
    const sha = this.#commit(parents, [...this.filesOf(head), ...(this.corruptMerge === 'tree' ? ['extra.txt'] : [])]);
    const commit = this.commits.get(sha);
    const headTree = this.commits.get(head)?.tree;
    // 실제 GitHub처럼 병합 커밋이 head와 같은 tree를 가리킨다.
    if (commit && headTree && this.corruptMerge !== 'tree') this.commits.set(sha, { ...commit, tree: headTree });
    this.branches.set(pull.base, sha);
    const before = this.pullJson(pull);
    Object.assign(pull, { state: 'closed', merged: true, mergeCommitSha: sha });
    if (this.pullReadLag > 0) this.#stale = { number, json: before, left: this.pullReadLag };
    if (this.dropNextMerge) {
      this.dropNextMerge = false;
      return { drop: true };
    }
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  /** 서버에 REST 경로를 올린다. */
  install(github: FakeGitHub): void {
    const repoPath = '/repos/:owner/:repo';
    const guard =
      (handler: (request: FakeRequest) => FakeResponse | Promise<FakeResponse>, need?: Permission) =>
      (request: FakeRequest) => {
        const limited = this.#rateLimited();
        if (limited) return limited;
        if (request.params?.owner !== this.owner || request.params.repo !== this.repo) {
          return { status: 404, body: { message: 'Not Found' } };
        }
        if (need && (this.options.tokenPermissions?.[need] ?? 'write') !== 'write') {
          return {
            status: 403,
            headers: { 'x-accepted-github-permissions': `${need === 'pulls' ? 'pull_requests' : need}=write` },
            body: { message: 'Resource not accessible by personal access token' },
          };
        }
        return handler(request);
      };
    const param = (request: FakeRequest, name: string) => request.params?.[name] ?? '';

    github.on('GET /user', () => {
      const limited = this.#rateLimited();
      if (limited) return limited;
      const headers: Record<string, string> = {};
      if (this.options.oauthScopes !== undefined) headers['x-oauth-scopes'] = this.options.oauthScopes;
      if (this.options.tokenExpiration !== undefined) {
        headers['github-authentication-token-expiration'] = this.options.tokenExpiration;
      }
      return { body: { login: this.options.login ?? 'agentwbs-bot' }, headers };
    });
    github.on(
      `GET ${repoPath}`,
      guard(() => ({
        body: {
          full_name: `${this.owner}/${this.repo}`,
          private: this.isPrivate,
          default_branch: 'main',
          permissions: this.options.permissions ?? { admin: false, push: true, pull: true },
        },
      })),
    );
    github.on(
      `GET ${repoPath}/branches/:branch`,
      guard((request) => {
        const sha = this.branches.get(param(request, 'branch'));
        if (!sha) return { status: 404, body: { message: 'Branch not found' } };
        return { body: { name: param(request, 'branch'), commit: { sha } } };
      }),
    );
    github.on(
      `GET ${repoPath}/git/trees/:sha`,
      guard((request) => {
        const commit = this.commits.get(param(request, 'sha'));
        if (!commit) return { status: 404, body: { message: 'Not Found' } };
        const files = this.trees.get(commit.tree) ?? [];
        const dirs = new Set<string>();
        for (const file of files) {
          const parts = file.split('/');
          for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
        }
        return {
          body: {
            sha: commit.tree,
            truncated: this.options.truncatedTree ?? false,
            // sha는 내용(아래 파일 목록)에서 만든다. 같은 내용이면 커밋이 달라도 같은 sha다(실제 Git과 같은 성질).
            tree: [
              ...[...dirs].map((path) => ({ path, type: 'tree', sha: sha1(`tree:${files.filter((f) => f.startsWith(`${path}/`)).sort().join('\n')}`) })),
              ...files.map((path) => ({ path, type: 'blob', sha: sha1(`blob:${path}`) })),
            ],
          },
        };
      }),
    );
    github.on(
      `GET ${repoPath}/git/ref/heads/agent/:name`,
      guard((request) => {
        const branch = `agent/${param(request, 'name')}`;
        const sha = this.branches.get(branch);
        if (!sha) return { status: 404, body: { message: 'Not Found' } };
        return { body: { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } } };
      }),
    );
    github.on(
      `DELETE ${repoPath}/git/refs/heads/agent/:name`,
      guard((request) => {
        const branch = `agent/${param(request, 'name')}`;
        if (!this.branches.delete(branch)) return { status: 422, body: { message: 'Reference does not exist' } };
        return { status: 204 };
      }, 'contents'),
    );
    github.on(
      `GET ${repoPath}/git/commits/:sha`,
      guard((request) => {
        const commit = this.commits.get(param(request, 'sha'));
        if (!commit) return { status: 404, body: { message: 'Not Found' } };
        return { body: { sha: commit.sha, tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) } };
      }),
    );
    github.on(
      `GET ${repoPath}/pulls`,
      guard((request) => {
        const [owner, branch] = (request.query.head ?? '').split(':');
        const state = request.query.state ?? 'open';
        const list = [...this.pulls.values()].filter(
          (pull) =>
            (owner === undefined || owner === '' || owner === this.owner) &&
            (branch === undefined || pull.head === branch) &&
            (state === 'all' || pull.state === state),
        );
        return { body: list.map((pull) => this.pullJson(pull)) };
      }),
    );
    github.on(
      `POST ${repoPath}/pulls`,
      guard((request) => {
        const body = request.body as { title: string; head: string; base: string; body?: string };
        if (!this.branches.has(body.head)) {
          return { status: 422, body: { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] } };
        }
        if ([...this.pulls.values()].some((p) => p.head === body.head && p.state === 'open')) {
          return {
            status: 422,
            body: { message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${this.owner}:${body.head}.` }] },
          };
        }
        const pull = this.openPull(body.head, body.title);
        pull.body = body.body ?? '';
        return { status: 201, body: this.pullJson(pull) };
      }, 'pulls'),
    );
    github.on(
      `GET ${repoPath}/pulls/:number`,
      guard((request) => {
        const number = Number(param(request, 'number'));
        if (this.#stale?.number === number && this.#stale.left > 0) {
          this.#stale.left -= 1;
          return { body: this.#stale.json };
        }
        const pull = this.pulls.get(number);
        return pull ? { body: this.pullJson(pull) } : { status: 404, body: { message: 'Not Found' } };
      }),
    );
    github.on(
      `PATCH ${repoPath}/pulls/:number`,
      guard((request) => {
        const pull = this.pulls.get(Number(param(request, 'number')));
        if (!pull) return { status: 404, body: { message: 'Not Found' } };
        const body = request.body as { state?: 'open' | 'closed' };
        if (body.state !== undefined && !pull.merged) pull.state = body.state;
        return { body: this.pullJson(pull) };
      }, 'pulls'),
    );
    github.on(
      `PUT ${repoPath}/pulls/:number/merge`,
      guard(async (request) => {
        if (this.#mergeGate) await this.#mergeGate;
        return this.merge(Number(param(request, 'number')), request.body as { sha?: string; merge_method?: string });
      }, 'contents'),
    );
    github.on(
      `POST ${repoPath}/statuses/:sha`,
      guard((request) => {
        const sha = param(request, 'sha');
        if (!this.commits.has(sha)) return { status: 422, body: { message: 'No commit found for SHA' } };
        const body = request.body as FakeStatus;
        const status: FakeStatus = {
          state: body.state,
          context: body.context,
          description: body.description ?? null,
          target_url: body.target_url ?? null,
        };
        this.statuses.set(sha, [status, ...(this.statuses.get(sha) ?? [])]);
        return { status: 201, body: status };
      }, 'statuses'),
    );
    github.on(
      `GET ${repoPath}/commits/:sha/statuses`,
      guard((request) => {
        // 실제 GitHub처럼 최신순, per_page 기본 30·최대 100, 다음 페이지는 Link rel="next"로 알린다.
        const all = this.statuses.get(param(request, 'sha')) ?? [];
        const perPage = Math.min(Number(request.query.per_page ?? 30) || 30, 100);
        const page = Math.max(Number(request.query.page ?? 1) || 1, 1);
        const body = all.slice((page - 1) * perPage, page * perPage);
        const headers: Record<string, string> = {};
        if (page * perPage < all.length) {
          headers.link = `<${github.url}${request.path}?per_page=${String(perPage)}&page=${String(page + 1)}>; rel="next"`;
        }
        return { body, headers };
      }),
    );
  }
}
