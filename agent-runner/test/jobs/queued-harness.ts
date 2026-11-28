import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApiClient, type OperationId } from '../../src/api/client.ts';
import { OPERATIONS, type ClaimedJob, type ExecutionHold } from '../../src/api/generated/client.ts';
import { sealCredential } from '../../src/github/credential.ts';
import { Secret } from '../../src/security/secret.ts';
import type { RunCommand } from '../../src/readiness/command.ts';
import { bodyErrors } from '../planning/schema.ts';
import { nodeHostSources } from '../../src/resources/host.ts';

export function testHostSources() {
  const actual = nodeHostSources();
  return { ...actual, readFile: (path: string) => path === '/proc/meminfo' ? Promise.resolve('MemTotal: 33554432 kB\nMemAvailable: 25000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n') : actual.readFile(path) };
}

export const probe: RunCommand = async (_file, args) => ({ code: 0, stderr: '', stdout: args.includes('--bundled') ? JSON.stringify({ models: [{ slug: 'fake-codex', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }] }) : args.includes('--json') ? '{"loggedIn":true}' : args.includes('--help') ? ' --effort <level> (low, medium, high)' : 'fake 26.13.0' });

export async function installPlanningCli(home: string) {
  const source = await readFile(new URL('../fakes/planning-cli.mjs', import.meta.url), 'utf8');
  const imported = new URL('../planning/harness.ts', import.meta.url).href;
  for (const name of ['codex', 'claude']) {
    const directory = join(home, 'cli', name, 'current', 'bin');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), source.replace("'../planning/harness.ts'", JSON.stringify(imported)), { mode: 0o700 });
  }
}

export function queuedServer(jobs: ClaimedJob[], extra: (operation: OperationId) => unknown = () => undefined) {
  const calls: { operation: OperationId; body: Record<string, unknown>; key: string | null }[] = [];
  const finished = new Map<string, Record<string, unknown>>();
  const holds = new Map<string, ExecutionHold>();
  const replay = new Map<string, Response>();
  const schemaErrors: string[] = [];
  let publicKey = '', hostId = '', bootId = '';
  const caps = { total: 6, Codex: 6, Claude: 6, heavy: 1 };
  const send: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const found = Object.entries(OPERATIONS).find(([, op]) => op.method === init?.method && new RegExp(`^${op.path.replace(/\{\w+\}/g, '[^/]+')}$`).test(path));
    if (!found) throw new Error(`가짜 서버에 없는 경로: ${path}`);
    const operation = found[0] as OperationId;
    const key = new Headers(init?.headers).get('idempotency-key');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ operation, body, key });
    if (init?.body) schemaErrors.push(...bodyErrors(operation, body).map(error => `${operation}: ${error}`));
    if (key && replay.has(key)) return replay.get(key)?.clone() as Response;
    const id = path.split('/')[4] ?? '';
    const hold = holds.get(id);
    let result: unknown, status = 204;
    if (operation === 'heartbeat') return new Response(null, { status: 204, headers: { 'x-current-epoch': '0' } });
    if (operation === 'getCommands') result = { currentEpoch: 0, commands: [] };
    if (operation === 'getRunnerPolicy') result = { heartbeatSeconds: 60, inputCheckMinutes: 5, inputRecheck: 0, inputCheckRequest: 0, subagentBudget: { dev: 0, qa: 0 }, cliGrades: [], claudeModels: ['fake-claude'], ci: { deployUrl: null } };
    if (operation === 'pollMessages') result = { messages: [], nextCursor: null };
    if (operation === 'reportHost') { hostId = String(body.hostId); bootId = String(body.bootId); result = { mode: 'auto', caps, recommended: caps, hostChanged: false }; }
    if (operation === 'reportConcurrency') result = { caps: { ...caps, memReserveGB: 0 } };
    if (operation === 'reportModels') result = { newModels: [] };
    if (operation === 'registerGithubKey') { publicKey = String(body.publicKeyPem); result = { keyId: 'fake-key' }; }
    if (operation === 'getGithubCredential') result = { sealed: sealCredential(publicKey, 'fake-github') };
    if (operation === 'claimJob') {
      const index = jobs.findIndex(job => (body.kinds as string[]).includes(job.kind));
      const job = index >= 0 ? jobs.splice(index, 1)[0] : undefined;
      if (job) {
        result = { job };
        if (!['repo_check', 'github_check'].includes(job.kind)) holds.set(job.id, { id: job.id, job: job.id, epoch: 0, fence: job.fence, project_id: null, task: null, attempt: null, host_id: hostId, boot_id: bootId,
          pgid: null, cgroup: null, agent: 'Codex', slots: 1, heavy: true, slot_state: 'reserved', lock_state: 'none', conflict_group: null, lock_from_job: null, handed_to_job: null, release_proof: null, closed_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
    }
    if (operation === 'renewJob') result = { leaseUntil: new Date(Date.now() + 60_000).toISOString() };
    if (operation === 'startJob') result = {};
    if (operation === 'getExecutionHolds') result = { holds: [...holds.values()].filter(hold => !hold.closed_at) };
    if (operation === 'reportJobProcess' && hold) { hold.slot_state = 'active'; hold.pgid = Number(body.processGroup); hold.cgroup = body.cgroup as string | null; }
    if (operation === 'releaseJobSlots' && hold) { hold.slot_state = 'none'; hold.release_proof = (body.proof as ExecutionHold['release_proof']); }
    if (operation === 'acquireJobSlots' && hold) { hold.slot_state = 'reserved'; hold.pgid = null; hold.cgroup = null; hold.agent = body.agent as 'Codex' | 'Claude' ?? hold.agent; }
    if (operation === 'releaseJob' && hold) hold.closed_at = new Date().toISOString();
    if (operation === 'finishJob') finished.set(id, body);
    if (operation === 'reportGithubStatus' && body.jobId) finished.set(String(body.jobId), { status: 'done' });
    if (operation === 'submitDraft') { status = 201; result = { revision: 1 }; }
    if (operation === 'submitPlanningProposal') { status = 201; result = { id: '00000000-0000-4000-8000-00000000c0de', cpKey: 'CP-0001', status: 'review' }; }
    if (['submitTechProposals', 'submitPlanningAnalysis', 'submitPlanningReviews'].includes(operation)) status = 201;
    if (operation === 'submitEstimates') result = {};
    if (operation === 'startCiRun') { status = 201; result = { id: crypto.randomUUID(), runKey: 'CI-0001' }; }
    result = extra(operation) ?? result;
    const response = result === undefined ? new Response(null, { status }) : Response.json(result, { status: status === 204 ? 200 : status });
    if (key) replay.set(key, response.clone());
    return response;
  };
  return { api: createApiClient({ baseUrl: 'http://fake-wbs.invalid', token: new Secret('fake-runner'), fetch: send }), calls, finished, holds, schemaErrors };
}
