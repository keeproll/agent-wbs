import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CiReport, CiStartBody, CiUpdateBody } from '../../src/ci/night/report.ts';
import { commit, definition, file, fixture, git } from './int-fixture.ts';

export interface StepCall { name: string; attempt: number; cwd: string; env: Record<string, string> }
export type StepScript = (call: StepCall) => Promise<{ code: number | null; stdout?: string; stderr?: string; report?: unknown; files?: Record<string, Buffer | string> }>;

/** 야간·배포 시험 공통: 정의를 바꾼 main, 가짜 실행기, 보고 기록. */
export async function ciFixture(stages: { night?: string[]; deploy?: string[] } = {}) {
  const f = await fixture();
  const pipeline = { ...definition, stages: { ...definition.stages,
    night: (stages.night ?? ['e2e']).map(name => ({ name, argv: ['fake', `night-${name}`] })),
    deploy: (stages.deploy ?? ['image', 'up', 'browser']).map(name => ({ name, argv: ['fake', `deploy-${name}`] })) } };
  await file(join(f.source, '.agentwbs/pipeline.yaml'), JSON.stringify(pipeline));
  const main = commit(f.source); git(f.source, 'push', f.remote, 'main');
  const calls: StepCall[] = [];
  const counts = new Map<string, number>();
  let script: StepScript = async () => ({ code: 0 });
  const execute = async (argv: readonly string[], cwd: string, _signal?: AbortSignal, env: Record<string, string> = {}) => {
    const name = String(argv[1]).replace(/^(night|deploy|int)-/, '');
    const attempt = (counts.get(name) ?? 0) + 1; counts.set(name, attempt);
    const call = { name, attempt, cwd, env }; calls.push(call);
    const out = await script(call);
    for (const [path, value] of Object.entries(out.files ?? {})) {
      const target = join(env.AWBS_EVIDENCE_DIR ?? '/nonexistent', path);
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, value);
    }
    if (out.report !== undefined && env.AWBS_REPORT) await writeFile(env.AWBS_REPORT, JSON.stringify(out.report));
    return { code: out.code, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };
  const reports: { kind: 'start' | 'update'; id?: string; key?: string; body: CiStartBody | CiUpdateBody }[] = [];
  let nextId = 1;
  const report: CiReport = {
    start: async (body, key) => { reports.push({ kind: 'start', key, body }); return { id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, runKey: 'CI-x' }; },
    update: async (id, body) => { reports.push({ kind: 'update', id, body }); },
  };
  const home = join(f.root, 'home');
  return { ...f, main, pipeline, calls, reports, report, home, execute,
    script: (next: StepScript) => { script = next; },
    final: () => reports.filter(r => r.kind === 'update').at(-1)?.body as CiUpdateBody,
    readJson: async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown };
}
