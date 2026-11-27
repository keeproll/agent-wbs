import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRepository } from '../../git/repository.ts';
import type { HeavySemaphore } from '../../resources/heavy.ts';
import { createRedactor, type Redact } from '../../security/redact.ts';
import { atomicWrite } from '../../state/files.ts';
import { parsePipeline } from '../pipeline.ts';
import type { CiReport } from '../night/report.ts';
import { Evidence, excerpt, type CiExecute } from '../night/steps.ts';
import { decodePng } from '../night/visual.ts';

export interface DeployOptions {
  repo: Pick<GitRepository, 'pipelineAt' | 'createTaskCheckWorktree' | 'taskCheckPath' | 'removeWorktree'>;
  heavy: HeavySemaphore;
  execute: CiExecute;
  report: CiReport;
  home: string;
  /** 서버가 준 deploy_check job. commit은 요청 시점의 main이다. */
  job: { jobId: string; fence: number; commit: string };
  /** 정책의 배포 확인 URL(ci.deployUrl). */
  url: string | null;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** 시간 제한은 벽시계가 아니라 단조 시계로 잰다. 이 PC는 벽시계가 뒤로 간다. */
  monotonic?: () => number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  redact?: Redact;
  signal?: AbortSignal;
}
export interface DeployStepResult { name: string; status: 'pass' | 'fail' | 'skip'; durationMs: number }
export interface DeployResult {
  runId: string; status: 'pass' | 'fail'; commit: string; pipelineSha: string; url: string | null;
  steps: DeployStepResult[]; failStep: string | null; screenshots: string[]; note: string;
  /** 실패했을 때 직전 통과 배포와, 실패 뒤 URL이 실제로 응답했는지 확인한 결과. 응답한 서비스의 커밋까지는 확인하지 않는다. */
  previous?: { commit: string; responding: boolean };
}
interface DeployState { version: 1; lastPass: { commit: string; tag: string } | null; images: string[] }

/** compose 프로젝트 이름을 고정해 이전 배포 확인의 컨테이너를 같은 이름으로 바꿔 띄운다. */
export const COMPOSE_PROJECT = 'agentwbs-deploy';
export const imageTag = (commit: string) => `agentwbs-deploy:${commit.slice(0, 12)}`;
// 실제 Docker·Node 문구: 'ports are not available', 'bind: address already in use', 'Bind for … failed: port is already allocated'.
const PORT_IN_USE = /EADDRINUSE|address already in use|port is already allocated|ports are not available/i;
/** Runner가 붙이는 단계. 정의의 단계 이름에는 `:`이 없어 겹치지 않는다(원칙 D). */
export const RUNNER_TARGET = 'runner:target';
export const RUNNER_URL = 'runner:url-check';
export const RUNNER_SHOTS = 'runner:screenshots';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

async function readState(directory: string): Promise<DeployState> {
  try {
    const path = join(directory, 'state.json');
    if (!(await lstat(path)).isFile()) throw new Error('배포 상태는 일반 파일이어야 합니다.');
    const value = JSON.parse(await readFile(path, 'utf8')) as DeployState;
    if (value.version !== 1 || !Array.isArray(value.images) || !value.images.every(i => typeof i === 'string' && i.startsWith('agentwbs-deploy:'))) {
      throw new Error('배포 상태가 손상되었습니다. 원본을 보존하고 확인하세요.');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, lastPass: null, images: [] };
    throw error;
  }
}

/**
 * ④ 배포 확인(G L477). 「Web Service 정상 기동 + 브라우저 접속」을 근거로 판정한다.
 * 정의의 deploy 단계(운영 빌드·compose up·Playwright 접속)를 실행한 뒤, Runner가 직접 URL에 접속해 보고 스크린샷 파일을 확인한다.
 * 왜: 단계가 「통과」라고 말한 것만으로는 근거가 아니다(G L466).
 * Q-15가 정해지기 전에는 이 PC(loopback)의 compose만 대상으로 한다.
 */
export async function runDeployCheck(options: DeployOptions): Promise<DeployResult> {
  const { repo, heavy, execute, report, home, job, signal } = options;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const send = options.fetch ?? globalThis.fetch;
  const redact = options.redact ?? createRedactor();
  /** 정한 시각까지 200이 올 때까지 다시 확인한다(조건 대기). deadline이 지금이면 한 번만 본다. */
  const probe = async (url: URL, deadline: number): Promise<{ ok: boolean; last: string }> => {
    let last = '';
    for (const check of url.pathname === '/api/health' ? [url] : [new URL('/api/health', url), url]) {
      let ok = false;
      while (!ok) {
        signal?.throwIfAborted();
        try {
          const response = await send(check, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
          await response.body?.cancel();
          ok = response.status === 200; last = `${check.href} → HTTP ${String(response.status)}`;
        } catch (error) { last = `${check.href} → ${error instanceof Error ? error.message : '접속 실패'}`; }
        if (ok || monotonic() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, options.healthIntervalMs ?? 1_000));
      }
      if (!ok) return { ok: false, last };
    }
    return { ok: true, last };
  };
  const stateDir = join(home, 'ci', 'deploy');
  const state = await readState(stateDir);
  const { pipelineSha, source } = await repo.pipelineAt(job.commit);
  const pipeline = parsePipeline(source);
  const tag = imageTag(job.commit);
  const names = [...pipeline.stages.deploy.map(s => s.name), RUNNER_URL, RUNNER_SHOTS];
  const started = await report.start({ jobId: job.jobId, fence: job.fence, stage: 'deploy', ref: 'main', trigger: '팀장 요청', headSha: job.commit, pipelineSha });
  await report.update(started.id, { fence: job.fence, status: 'run' });
  const evidence = await Evidence.open(home, started.id, redact);
  const result: DeployResult = { runId: started.id, status: 'fail', commit: job.commit, pipelineSha, url: options.url,
    steps: names.map(name => ({ name, status: 'skip', durationMs: 0 })), failStep: null, screenshots: [], note: '' };
  const notes: string[] = [];
  let logExcerpt = null as string | null;
  const fail = (name: string, detail: string) => {
    let step = result.steps.find(s => s.name === name);
    if (!step) { step = { name, status: 'fail', durationMs: 0 }; result.steps.unshift(step); }
    step.status = 'fail'; result.failStep = name; logExcerpt = detail;
  };

  let target: URL | null;
  try { target = options.url ? new URL(options.url) : null; } catch { target = null; }
  if (!target || !['http:', 'https:'].includes(target.protocol) || !LOOPBACK.has(target.hostname)) {
    fail(RUNNER_TARGET, '배포 확인 URL이 없거나 이 PC 주소가 아닙니다.');
    notes.push('Q-15(배포 대상) 결정 전에는 이 PC의 docker compose만 확인합니다');
  } else {
    const url = target;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const release = await heavy.acquire(`ci-deploy:${job.commit}`, signal);
    const id = `deploy-${randomUUID()}`;
    let created = false;
    try {
      const path = await repo.createTaskCheckWorktree(id, job.commit); created = true;
      const env = { AWBS_DEPLOY_COMMIT: job.commit, AWBS_DEPLOY_TAG: tag, AWBS_DEPLOY_URL: url.href.replace(/\/$/, ''), COMPOSE_PROJECT_NAME: COMPOSE_PROJECT };
      const shots: string[] = [];
      for (const [index, command] of pipeline.stages.deploy.entries()) {
        const step = result.steps[index];
        if (!step) throw new Error('배포 단계가 없습니다.');
        const begin = performance.now();
        await repo.taskCheckPath(id, job.commit);
        const attempt = await evidence.run(execute, command.argv, path, `${command.name}-1`, env, signal);
        step.durationMs = Math.max(0, Math.round(performance.now() - begin));
        // 각 단계 뒤에도 사본이 커밋과 같아야 한다. 다른 파일로 한 확인을 그 커밋의 근거로 남기지 않는다(원칙 C).
        const changed = await repo.taskCheckPath(id, job.commit).then(() => null, (error: unknown) => `단계가 검사 사본의 커밋 파일을 바꿨습니다: ${error instanceof Error ? error.message : ''}`);
        if (changed) { fail(command.name, changed); break; }
        if (attempt.result.code !== 0 || attempt.reportError) {
          fail(command.name, excerpt(attempt.result, attempt.reportError));
          if (PORT_IN_USE.test(`${attempt.result.stderr}\n${attempt.result.stdout}`)) notes.push(`포트 ${port} 사용 중`);
          break;
        }
        step.status = 'pass';
        shots.push(...attempt.report?.screenshots ?? []);
      }
      if (!result.failStep) {
        const step = result.steps[names.indexOf(RUNNER_URL)];
        const begin = monotonic();
        const checked = await probe(url, begin + (options.healthTimeoutMs ?? 60_000));
        if (step) step.durationMs = Math.max(0, Math.round(monotonic() - begin));
        if (!checked.ok) fail(RUNNER_URL, `접속 확인 실패: ${checked.last}`);
        else if (step) step.status = 'pass';
      }
      if (!result.failStep) {
        const step = result.steps[names.indexOf(RUNNER_SHOTS)];
        try {
          if (!shots.length) throw new Error('브라우저 접속 스크린샷이 없습니다.');
          for (const shot of new Set(shots)) { decodePng(await evidence.file(shot)); result.screenshots.push(shot); }
          if (step) step.status = 'pass';
          notes.push(`접속 확인 — 스크린샷 ${String(result.screenshots.length)}장`);
        } catch (error) {
          fail(RUNNER_SHOTS, error instanceof Error ? error.message : '스크린샷을 확인하지 못했습니다.');
        }
      }
      if (!result.failStep) result.status = 'pass';
    } catch (error) {
      const current = result.steps.find(s => s.status === 'skip') ?? result.steps[0];
      fail(current?.name ?? 'deploy', redact(error instanceof Error ? error.message : '배포 확인을 실행하지 못했습니다.'));
    } finally {
      try { if (created) await repo.removeWorktree(id); }
      finally { release(); }
    }
  }

  // 이미지 보존: 통과한 이미지는 다음 배포 확인까지만, 실패하면 직전 통과 이미지를 남긴다(G L489).
  const lastPass = result.status === 'pass' ? { commit: job.commit, tag } : state.lastPass;
  const images = [...new Set([...state.images, ...(result.failStep === RUNNER_TARGET ? [] : [tag])])];
  const keep = new Set([lastPass?.tag, result.status === 'pass' ? tag : undefined].filter(Boolean));
  const remaining: string[] = [];
  for (const image of images) {
    if (keep.has(image) || image === tag && result.status !== 'pass') { remaining.push(image); continue; }
    const removed = await execute(['docker', 'image', 'rm', '--', image], home, signal).catch(() => ({ code: null }));
    if (removed.code !== 0) { remaining.push(image); notes.push(`이전 이미지 ${image} 정리 실패`); }
  }
  // 이전 서비스가 유지되는지는 짐작하지 않는다. 실패 뒤 실제로 접속해 본 결과만 적는다(원칙 C).
  if (result.status === 'fail' && result.failStep !== RUNNER_TARGET && target) {
    const after = await probe(new URL('/api/health', target), monotonic());
    notes.push(after.ok ? '실패 뒤 접속 확인: /api/health 응답 200(응답한 서비스의 커밋은 확인하지 않음)' : `실패 뒤 접속 확인: 응답 없음(${after.last})`);
    if (state.lastPass) {
      result.previous = { commit: state.lastPass.commit, responding: after.ok };
      notes.push(`직전 통과 커밋 ${state.lastPass.commit.slice(0, 7)}의 이미지는 남겨 둠`);
    }
  }
  if (result.failStep && result.failStep !== RUNNER_TARGET) notes.unshift(`실패 단계: ${result.failStep}`);
  result.note = notes.join(' · ');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await atomicWrite(stateDir, 'state.json', `${JSON.stringify({ version: 1, lastPass, images: remaining } satisfies DeployState)}\n`);
  const finishedAt = new Date(now()).toISOString();
  await evidence.finish({ stage: 'deploy', status: result.status, commit: job.commit, finishedAt });
  await report.update(started.id, {
    fence: job.fence, status: result.status, finishedAt,
    steps: result.steps.map(({ name, status, durationMs }) => ({ name, status, durationMs })),
    ...(options.url && target && { url: options.url }),
    ...(result.note && { note: result.note }),
    ...(logExcerpt && { logExcerpt: redact(logExcerpt) }),
    artifacts: evidence.artifacts,
  });
  return result;
}
