import type { ApiRequest } from '../api/client.ts';
import { isDeepStrictEqual } from 'node:util';
import type { ClaimedJob } from '../api/generated/client.ts';
import type { RunnerApp, RunnerAppDeps } from '../app.ts';
import { ciLaunch } from '../ci/launch.ts';
import { runDeployCheck } from '../ci/deploy/run.ts';
import { buildDesignSnapshot } from '../design/snapshot.ts';
import { DESIGN_LIMITS, compareShapes, validShape } from '../design/shape.ts';
import type { GitRepository } from '../git/repository.ts';
import { normalizeRepoUrl } from '../git/identity.ts';
import { pushGate, serverWriteGuard } from '../github/write-gate.ts';
import { PLANNING_KINDS, PlanningCheckpoints, runPlanningJob, type PlanningJob, type PlanningOutcome } from '../planning/index.ts';
import { planningAgents, planningText } from '../planning/cli.ts';
import type { QueuedJobs } from './queued.ts';

async function contracts(repo: GitRepository, commit: string) {
  const paths = await repo.listFiles(commit, 'contracts/');
  if (paths.length > 1000) throw new Error('계약 파일 수 상한(1000)을 넘었습니다.');
  const files = [];
  let bytes = 0;
  for (const path of paths) {
    const raw = await repo.fileAt(commit, path);
    bytes += raw.length;
    if (raw.length > DESIGN_LIMITS.fileBytes || bytes > DESIGN_LIMITS.reportBytes / 2) throw new Error('계약 원문 크기 상한을 넘었습니다.');
    files.push({ path, raw: raw.toString('utf8') });
  }
  return files;
}

/** 실제 앱의 공유 API·Execution·GitHub만 쓴다. Agent의 말로 접근 성공·커밋·검사 결과를 대신하지 않는다. */
export async function executeQueued(app: RunnerApp, d: RunnerAppDeps, job: ClaimedJob, signal: AbortSignal, report: QueuedJobs['report'], remember: QueuedJobs['remember']): Promise<PlanningOutcome> {
  const epoch = d.state.snapshot.epoch;
  if (job.kind === 'repo_check') {
    const result = await remember('repo-result', async () => {
      const result = await app.repositoryClient(job.payload.url).checkRepository();
      const configured = d.github && `https://github.com/${d.github.repo.owner}/${d.github.repo.repo}`;
      if (!configured || normalizeRepoUrl(job.payload.url) !== normalizeRepoUrl(configured)) result.error = '등록 주소가 Runner의 AWBS_GITHUB_REPO와 다릅니다. 같은 저장소로 설정한 뒤 다시 확인하세요.';
      return result;
    });
    signal.throwIfAborted();
    await report('repo-result', 'reportRepoCheck', { epoch, params: { id: job.payload.repoCheckId }, body: { fence: job.fence, ...result } });
    return { status: 'done', result: {} };
  }
  if (job.kind === 'github_check') {
    const body = await remember('github-result', () => app.checkGithubJob(job.payload.mode, signal));
    await report('github-result', 'reportGithubStatus', { epoch, body: { ...body, jobId: job.id, fence: job.fence } });
    return { status: 'done', result: {} };
  }
  const repo = await app.openRepository();
  const github = app.github;
  if (!github) throw new Error('GitHub 연결 설정이 없습니다.');
  const ref = { id: job.id, fence: job.fence, epoch };
  const gate = pushGate(github.client, serverWriteGuard(d.api, job, epoch, signal), signal);
  const systemPush = async (commit: string, parent: string) => {
    if (commit === parent) return;
    const ssh = d.github?.systemKey;
    if (!ssh) throw new Error('작업 구역 생성·계약 반영에는 owner의 시스템 배포 키 설정이 필요합니다.');
    await repo.pushSystemCommit(commit, parent, ssh, gate);
  };
  if (PLANNING_KINDS.includes(job.kind as typeof PLANNING_KINDS[number])) {
    const planning = job as PlanningJob;
    const checkpoints = await PlanningCheckpoints.open(d.home);
    const workId = `planning-${job.id}`, branch = `agent/${workId}`;
    let cwd: string | undefined;
    const agents = planningAgents(async (agent, prompt) => {
      if (!cwd) {
        const work = await repo.worktreeState(workId);
        const base = planning.kind === 'bootstrap' || planning.kind === 'input_diff' ? planning.payload.commit : await repo.fetch();
        cwd = work.kind === 'ready' ? work.path : await repo.createWorktree(workId, branch, base);
      }
      const model = d.env[agent === 'Codex' ? 'AWBS_PLANNING_CODEX_MODEL' : 'AWBS_PLANNING_CLAUDE_MODEL'];
      if (!model) throw new Error('Planning 모델이 설정되지 않았습니다.');
      return app.execution.agent(ref, agent, { model, effort: d.agentMaxEffort ?? 'high', cwd, prompt, readOnly: true }, signal);
    });
    try {
      return await runPlanningJob(planning, { api: d.api, epoch, runnerId: d.state.snapshot.runnerId, checkpoints, agents, signal,
        workspace: {
          fixCommit: async commit => {
            await repo.fetch();
            if (!await repo.hasCommit(commit)) throw new Error('요청된 입력 커밋을 저장소에서 확인하지 못했습니다.');
            return { note: `입력 커밋 ${commit.slice(0, 7)} 확인` };
          },
          checkoutInput: async (name, commit) => ({ path: await repo.inputPath(name) ?? await repo.checkoutInput(name, commit), note: '고정 커밋 prototype/ 읽기 전용 사본' }),
          prepareWork: async () => { const prepared = await repo.prepareProject(); await systemPush(prepared.commit, prepared.parent); return { note: '작업 저장소와 src/·contracts/·.agentwbs/ 준비 확인' }; },
          diff: async (previous, commit) => (await repo.inputObservation(previous, commit)).changes,
        } });
    } finally { if (cwd) await repo.removeWorktree(workId); }
  }
  if (job.kind === 'deploy_check') {
    const result = await runDeployCheck({ repo, heavy: app.heavy, home: d.home, job: { jobId: job.id, fence: job.fence, commit: job.payload.commit },
      url: app.runner.policy?.ci.deployUrl ?? null, signal,
      execute: (argv, cwd, stopped, env) => app.execution.command(ref, 'Codex', { ...ciLaunch(argv, cwd, d.env), env: { ...ciLaunch(argv, cwd, d.env).env, ...env } }, stopped, { heavyHeld: true }),
      report: {
        start: async body => (await report('deploy:start', 'startCiRun', { epoch, body })).body,
        update: async (id, body) => { await report(`deploy:${body.status}`, 'updateCiRun', { epoch, params: { id }, body }); },
      } });
    return result.status === 'pass' ? { status: 'done', result: { ciRunId: result.runId } } : { status: 'failed', error: { code: 'DEPLOY_CHECK_FAILED', message: result.note || '배포 확인 실패' } };
  }
  if (job.kind === 'merge_followup') {
    const pr = await github.client.getPullRequest(job.payload.pr);
    if (!pr.merged || !pr.mergeCommitSha) throw new Error('PR 병합 결과 커밋을 확인하지 못했습니다.');
    const commit = await repo.fetch();
    if (!await repo.hasCommit(pr.mergeCommitSha) || await repo.taskBase(pr.mergeCommitSha, commit) !== pr.mergeCommitSha) throw new Error('병합 커밋이 현재 main의 이력에 없습니다.');
    const body = await buildDesignSnapshot({ jobId: job.id, fence: job.fence, ref: 'main', jobKind: job.kind, commit, files: await contracts(repo, commit) });
    await report('design-result', 'reportDesignSnapshot', { epoch, body });
    return { status: 'done', result: { commit } };
  }
  if (job.kind === 'design_apply') {
    const output = await remember('design-output', async () => {
      const context = (await d.api('getDesignApplyJob', { epoch, params: { id: job.id }, query: { fence: job.fence } })).body;
      if (!validShape(context.target) || !context.path.startsWith('contracts/')) throw new Error('계약 반영 대상이 올바르지 않습니다.');
      const parent = await repo.fetch();
      if (parent !== context.sourceCommit) throw new Error('main이 계약 반영 요청 뒤 바뀌었습니다. 최신 코드로 다시 대조하세요.');
      const workId = `design-${job.id}`, branch = `agent/${workId}`;
      const work = await repo.worktreeState(workId);
      const cwd = work.kind === 'ready' ? work.path : await repo.createWorktree(workId, branch, parent);
      try {
        const model = d.env.AWBS_PLANNING_CLAUDE_MODEL;
        if (!model) throw new Error('Planning Claude 모델이 설정되지 않았습니다.');
        planningText('Claude', await app.execution.agent(ref, 'Claude', { model, effort: d.agentMaxEffort ?? 'high', cwd,
          prompt: `설계 계약의 ${JSON.stringify(context.path)} 파일에서 ${JSON.stringify(job.payload.itemKey)} 항목만 다음 명세와 같게 고치고 지금 브랜치에 단일 커밋을 만드세요. 다른 파일·항목·원격은 바꾸지 말고 하위 Agent나 다른 AI CLI를 호출하지 마세요. 목표는 이미 추출한 코드 명세입니다: ${JSON.stringify(context.target)}. 마지막에 변경 요약을 답하세요.` }, signal));
        const commit = await repo.importWorktree(workId, branch);
        if ((await repo.commitParents(commit)).join(' ') !== parent || (await repo.changedPaths(parent, commit)).some(path => path !== context.path)) throw new Error('계약 반영 결과가 지정 파일만 바꾼 단일 커밋이 아닙니다.');
        const files = await contracts(repo, commit);
        // 코드 파일이 하나도 바뀌지 않아 원본 커밋에서 확인한 추출 명세를 재사용할 수 있다.
        const extractor = async ({ item }: { item: { itemKey: string } }) => item.itemKey === job.payload.itemKey ? context.target : null;
        const body = await buildDesignSnapshot({ commit, jobId: job.id, fence: job.fence, ref: 'main', jobKind: job.kind, files }, { openapi: extractor, asyncapi: extractor, sql: extractor });
        const before = await buildDesignSnapshot({ commit: parent, jobId: job.id, fence: job.fence, ref: 'main', jobKind: job.kind, files: await contracts(repo, parent) });
        if (!isDeepStrictEqual(before.items.filter(item => item.itemKey !== job.payload.itemKey), body.items.filter(item => item.itemKey !== job.payload.itemKey))) throw new Error('지정한 항목 외 계약이 바뀌었습니다.');
        const item = body.items.find(item => item.itemKey === job.payload.itemKey);
        if (!item?.contract || compareShapes(item.contract, context.target, item.kind) || compareShapes(context.target, item.contract, item.kind)) throw new Error('고친 계약이 요청한 추출 명세와 다릅니다.');
        return { commit, parent, body: body as ApiRequest<'reportDesignSnapshot'>['body'] };
      } finally { await repo.removeWorktree(workId); }
    });
    if (output.body.commit !== output.commit || output.body.jobId !== job.id || output.body.fence !== job.fence) throw new Error('저장된 계약 반영 결과가 지금 job과 다릅니다.');
    // 응답을 잃은 push는 원격 main부터 읽는다. 결과 커밋이 이미 있으면 CLI·push를 반복하지 않는다.
    const remote = await repo.fetch();
    if (remote === output.parent) await systemPush(output.commit, output.parent);
    else if (remote !== output.commit) throw new Error('계약 반영 중 main이 바뀌었습니다. 최신 코드로 다시 대조하세요.');
    await report('design-result', 'reportDesignSnapshot', { epoch, body: output.body });
    return { status: 'done', result: { commit: output.commit } };
  }
  throw new Error('이 수신 창구가 처리하는 job이 아닙니다.');
}
