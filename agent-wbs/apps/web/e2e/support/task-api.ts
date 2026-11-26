/**
 * Task 상세 E2E용 가짜 서버 — 원본 Mock 데이터(fixtures/prototype-mock.json)를 계약 모양으로 바꿔 돌려준다.
 *
 * - prototype-mock.json은 원본 화면(Main.dc.html)을 2026-11-05 20:00 KST 시계로 연 뒤 화면 상태의 데이터를 그대로 꺼낸 것이다.
 *   왜: 시각 비교에서 원본과 같은 내용이 보여야 차이가 「모양」 차이만 남는다.
 * - 저장 요청은 메모리 안에서 반영한다. 버전(updatedAt)이 다르면 409 VERSION_CONFLICT를 돌려준다(서버와 같은 규칙).
 * - 응답 타입은 계약(ResponseOf)으로 적어, 계약이 바뀌면 typecheck가 실패한다.
 */
import type { Route } from '@playwright/test';
import type { ResponseOf } from '../../src/shared/api/contract.ts';
import raw from '../fixtures/prototype-mock.json' with { type: 'json' };
import { errorBody, json, type FakeApi } from './fake-api.ts';

type Detail = ResponseOf<'getTask'>;
type Summary = ResponseOf<'listTasks'>['tasks'][number];
type Node = ResponseOf<'listTasks'>['nodes'][number];
type Attempt = ResponseOf<'getTaskAttempts'>['items'][number];
type Verification = ResponseOf<'getTaskVerifications'>['items'][number];
type Evidence = ResponseOf<'listEvidence'>['items'][number];
type History = ResponseOf<'getTaskHistory'>['items'][number];
type Message = ResponseOf<'getTaskMessages'>['items'][number];
type Gate = ResponseOf<'getTaskGate'>;

/* eslint-disable @typescript-eslint/no-explicit-any -- 원본 Mock JSON은 타입이 없다 */
const P = raw as any;

/** 'YYYY-MM-DD HH:mm'(KST) → ISO */
export const iso = (kst: string) => new Date(`${kst.replace(' ', 'T')}:00+09:00`).toISOString().replace('Z', '000Z');
const day = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const uuid = (key: string) => `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`;
const SPEC_KEYS = ['req', 'work', 'steps', 'inputs', 'outputs', 'files', 'constraints', 'errors', 'docs', 'verify'] as const;
const KIND: Record<string, Attempt['kind']> = { 개발: 'dev', QA: 'qa', 재작업: 'rework', 재검증: 'reverify' };
const ATT_ST: Record<string, Attempt['status']> = { 완료: 'completed', 실패: 'failed', '실행 중': 'running', 중단: 'interrupted' };
const STARTED = (s: string) => !['planning', 'approval', 'ready', 'cancelled'].includes(s);

export interface TaskStore {
  tasks: Map<string, any>;
  deps: { id: string; pred: string; succ: string; type: 'FS' | 'SS' }[];
  attempts: any[];
  verifs: any[];
  hist: any[];
  msgs: any[];
  version: Map<string, string>;
  seq: number;
  now: () => string;
}

export function newStore(): TaskStore {
  const tasks = new Map<string, any>(Object.entries(structuredClone(P.tasks)));
  const version = new Map<string, string>();
  for (const [k, t] of tasks) version.set(k, iso(t.updated));
  return { tasks, deps: structuredClone(P.deps), attempts: structuredClone(P.attempts), verifs: structuredClone(P.verifs), hist: structuredClone(P.hist), msgs: structuredClone(P.msgs), version, seq: 0, now: () => '2026-11-05 20:00' };
}

export function nodes(): Node[] {
  const out: Node[] = [];
  P.phases.forEach((ph: any, i: number) => {
    out.push({ id: ph.id, kind: 'phase', parentId: null, title: ph.title, wbsPath: String(i + 1), sortOrder: i });
    ph.wps.forEach((wp: any, j: number) => { out.push({ id: wp.id, kind: 'work_package', parentId: ph.id, title: wp.title, wbsPath: `${String(i + 1)}.${String(j + 1)}`, sortOrder: j }); });
  });
  return out;
}

function place(key: string): { wp: string; path: string } {
  let r = { wp: '', path: '' };
  P.phases.forEach((ph: any, i: number) => ph.wps.forEach((wp: any, j: number) => wp.tasks.forEach((k: string, n: number) => {
    if (k === key) r = { wp: wp.id, path: `${String(i + 1)}.${String(j + 1)}.${String(n + 1)}` };
  })));
  return r;
}

const met = (s: TaskStore, d: { pred: string; type: string }) => {
  const st = s.tasks.get(d.pred)?.status ?? '';
  return d.type === 'SS' ? STARTED(st) : st === 'done';
};
const isBlocked = (s: TaskStore, key: string) => s.tasks.get(key)?.status !== 'done' && s.deps.filter((d) => d.succ === key).some((d) => !met(s, d));

/** 원본 Sel.gate(P L3689) */
export function gate(s: TaskStore, key: string): Gate {
  const t = s.tasks.get(key);
  const cl = t.checklist as any[];
  const reqLeft = cl.filter((c) => c.required && !c.done).length;
  const outs = (t.outputs ?? []) as any[];
  const reqO = outs.filter((o) => o.required !== false);
  const miss = reqO.filter((o) => !o.delivered);
  const vr: Record<string, string> = { pass: '최근 검증 PASS', fail: '최근 QA FAIL — 재작업 후 재검증 필요', running: '검증 진행 중', none: '검증 미실시', blocked: '검증 BLOCKED — 원인 해결 후 재검증 필요' };
  return {
    taskKey: key,
    passed: false,
    conditions: [
      { key: 'checklist', result: !cl.length || reqLeft ? 'FAIL' : 'PASS', reason: !cl.length ? '체크리스트 미등록' : reqLeft ? `필수 항목 ${String(reqLeft)}건 미완료` : '필수 항목 모두 완료' },
      { key: 'outputs', result: !reqO.length || miss.length ? 'FAIL' : 'PASS', reason: !outs.length ? '예상 산출물 미정의' : !reqO.length ? '필수 산출물 미지정' : miss.length ? `미제출: ${miss.map((o) => o.name as string).join(', ')}` : `필수 산출물 ${String(reqO.length)}건 제출` },
      { key: 'verification', result: t.verif === 'pass' ? 'PASS' : t.verif === 'fail' ? 'FAIL' : 'BLOCKED', reason: vr[t.verif] ?? '' },
      { key: 'defects', result: t.defects ? 'FAIL' : 'PASS', reason: t.defects ? `차단 결함 ${String(t.defects)}건 미해결` : '미해결 결함 없음' },
      { key: 'approval', result: t.approved ? 'PASS' : 'BLOCKED', reason: t.approved ? '팀장 승인 완료' : '팀장 승인 대기' },
    ],
  };
}

export function summary(s: TaskStore, key: string): Summary {
  const t = s.tasks.get(key);
  const sc = P.sch?.[key];
  const g = gate(s, key);
  const p = place(key);
  return {
    id: uuid(key), taskKey: key, wbsNodeId: p.wp, wbsPath: p.path, title: t.title, workType: t.type, primaryDomain: t.domain, relatedDomains: t.rel ?? [],
    priority: t.priority, assigneeAgent: t.assignee ?? null, verifierAgent: t.verifier ?? null, lifecycleStatus: t.status, verifState: t.verif,
    blocked: isBlocked(s, key), preds: s.deps.filter((d) => d.succ === key).map((d) => d.pred),
    checklist: { done: (t.checklist as any[]).filter((c) => c.done).length, total: (t.checklist as any[]).length },
    gate: { passed: g.conditions.filter((c) => c.result === 'PASS').length, total: 5 },
    schedule: sc ? { estHours: sc.est, loHours: sc.lo, hiHours: sc.hi, progressPct: sc.pct, end: day(sc.fe), baselineEnd: sc.isNew ? null : day(sc.pe) } : null,
    updatedAt: s.version.get(key) ?? '', deletedAt: null,
  };
}

export function detail(s: TaskStore, key: string): Detail {
  const t = s.tasks.get(key);
  const spec = Object.fromEntries(SPEC_KEYS.map((k) => [k, (t.spec?.[k] ?? []) as string[]])) as Detail['spec']['spec'];
  const dep = (d: { id: string; pred: string; succ: string; type: 'FS' | 'SS' }) => ({ id: d.id, pred: d.pred, succ: d.succ, type: d.type });
  const grade = (r: any) => (r ? { modelId: r.model, effort: r.effort, reason: r.basis ?? '', locked: !!r.locked } : null);
  return {
    ...summary(s, key),
    spec: {
      overview: { purpose: t.purpose ?? '', background: t.background ?? '', scope: t.scope ?? [], out: t.out ?? [], precond: t.precond ?? '', doneCond: t.doneCond ?? '' },
      spec,
      ac: ((t.spec?.ac ?? []) as any[]).map((a) => ({ given: a.given, when: a.when, then: a.then, method: a.method ?? '' })),
    },
    outputs: ((t.outputs ?? []) as any[]).map((o) => ({ name: o.name, kind: o.kind ?? '코드', required: o.required !== false, verify: o.verify ?? '', delivered: !!o.delivered })),
    designs: ((t.design ?? []) as any[]).map((d) => (d.removed ? { kind: d.kind, content: {} } : { kind: d.kind, content: { ents: d.ents ?? [], b: d.b ?? {} } })),
    checklistItems: (t.checklist as any[]).map((c) => ({ itemKey: c.id, content: c.text, required: c.required, done: c.done, verifyMethod: c.method || null, evidence: c.evidence || null, note: c.note || null })),
    predecessors: s.deps.filter((d) => d.succ === key).map(dep),
    successors: s.deps.filter((d) => d.pred === key).map(dep),
    planningApprovedAt: t.approved ? iso('2026-10-27 10:20') : null,
    // M3 통합: main(srv-perf)에서 getTask에 추가된 칸. M3-03 화면은 아직 읽지 않으므로 빈 값으로 둔다.
    estimate: null, fixStart: null, actStart: null, actEnd: null, actualHours: 0,
    conflictGroup: t.cg ?? null,
    srcInputVersion: t.srcV ?? null,
    grades: { dev: grade(t.run), qa: grade(t.vrun) },
    subagents: { dev: ((t.subs?.dev ?? []) as any[]).map((x) => x.id as string), qa: ((t.subs?.qa ?? []) as any[]).map((x) => x.id as string) },
    split: t.split ? { basis: t.split.basis, judgedRules: null, exceptions: ((t.split.exc ?? []) as any[]).map((e) => ({ rule: e.rule, why: e.why, by: e.by, at: iso(e.at) })) } : null,
  };
}

export function attempts(s: TaskStore, key: string): Attempt[] {
  return s.attempts.filter((a) => a.task === key).map((a) => ({
    id: uuid(a.id), attemptKey: a.id, taskKey: key, kind: KIND[a.kind] ?? 'dev', agent: a.agent, status: ATT_ST[a.status] ?? 'completed',
    startedAt: iso(a.start), endedAt: a.end ? iso(`${(a.start as string).slice(0, 10)} ${a.end as string}`) : null,
    modelId: a.model ?? null, effort: a.effort ?? null,
    gradeAdjust: a.esc ? { kind: a.escKind === 'down' ? 'down' : 'up', from: { model: a.model, effort: a.effort }, to: { model: a.model, effort: a.effort }, reason: a.esc } : null,
    summary: a.summary || null, failure: a.fail || null, tokens: a.tok ? a.tok * 1000 : null, resumedFrom: null, baseSha: null, headSha: null, changedFiles: a.files ?? [], updatedAt: iso(a.start),
  }));
}

const evKind = (p: string) => (/\.(png|jpe?g|gif)$/i.test(p) ? '스크린샷' : /\.(log|txt)$/i.test(p) ? '로그' : /\.json$/i.test(p) ? '측정 데이터' : /\.sql$/i.test(p) ? 'SQL' : /\.md$/i.test(p) ? '문서' : '파일');
export function verifications(s: TaskStore, key: string): { vs: Verification[]; ev: Evidence[] } {
  const vs: Verification[] = [];
  const ev: Evidence[] = [];
  for (const v of s.verifs.filter((x) => x.task === key)) {
    vs.push({ id: uuid(v.id), taskKey: key, attemptId: uuid(v.attempt), result: v.result, headSha: '3f9c2a1b7d', specRevision: 1, cmd: v.cmd, expected: v.expected, actual: v.actual,
      defects: (v.defects as string[]).map((d, i) => ({ defKey: `D-${String(i + 1)}`, text: d, blocking: true, resolved: false })), invalidated: false, at: iso(v.at) });
    (v.evidence as string[]).forEach((p, i) => { ev.push({ id: uuid(`${String(v.id)}9${String(i)}`), taskKey: key, attemptId: null, verificationId: uuid(v.id), checklistItemKey: null, kind: evKind(p), sha256: 'a'.repeat(64), size: 1024 }); });
  }
  return { vs, ev };
}

export function history(s: TaskStore, key: string): History[] {
  return s.hist.filter((h) => h.task === key).map((h) => ({ id: h.id, at: iso(h.at), actor: h.actor, taskKey: key, kind: h.kind, text: h.text, before: h.before || null, after: h.after || null, ref: null }));
}

export function messages(s: TaskStore, key: string): Message[] {
  return s.msgs.filter((m) => m.task === key).map((m) => ({
    id: uuid(m.id), msgKey: m.id, taskKey: key, attemptId: m.attempt ? uuid(m.attempt) : null, dir: m.dir, type: m.dir === 'in' ? '응답' : m.type,
    toAgent: m.dir === 'out' ? m.to : m.from, body: m.body, delivery: m.dir === 'out' ? m.delivery : null, pendingNext: !!m.pendingNext, workState: m.work || null,
    failReason: m.failReason || null, readAt: m.unread ? null : iso(m.at), createdAt: iso(m.at), updatedAt: iso(m.at),
  }));
}

const page = <T>(items: T[]) => ({ items, nextCursor: null });

/**
 * 가짜 API에 Task 관련 요청을 붙인다. 저장은 메모리 store에 반영한다.
 * opts.fail로 특정 요청을 실패시키거나 opts.onRequest로 받은 본문을 기록할 수 있다.
 */
export function mountTasks(api: FakeApi, s: TaskStore = newStore()): TaskStore {
  const keys = () => [...s.tasks.keys()];
  api.on('GET /api/projects/p1/tasks', (route) => json(route, 200, { nodes: nodes(), tasks: keys().map((k) => summary(s, k)) }));
  for (const k of keys()) mountOne(api, s, k);
  api.on('GET /api/evidence', (route, req) => {
    const key = new URL(req.url()).searchParams.get('taskKey') ?? '';
    return json(route, 200, page(s.tasks.has(key) ? verifications(s, key).ev : []));
  });
  for (const d of s.deps) mountDepDelete(api, s, d.id);
  return s;
}

function bump(s: TaskStore, key: string, entries: { kind: string; text: string; before?: string; after?: string }[]) {
  s.seq += 1;
  const at = new Date(Date.parse('2026-11-05T11:00:00Z') + s.seq * 60_000).toISOString().replace('Z', '000Z');
  s.version.set(key, at);
  for (const e of entries) s.hist.push({ id: `H-X${String(s.seq)}-${e.kind}`, at: '2026-11-05 20:00', actor: '팀장', task: key, kind: e.kind, text: e.text, before: e.before ?? '', after: e.after ?? '' });
}

export function mountOne(api: FakeApi, s: TaskStore, key: string): void {
  const base = `/api/tasks/${key}`;
  const changed = (route: Route, status = 200) => json(route, status, { task: detail(s, key), changes: [] });
  /** 버전 확인 — 다르면 409(서버 규칙). 맞으면 true */
  const fresh = async (route: Route, version: string | null | undefined) => {
    if (version === s.version.get(key)) return true;
    await json(route, 409, errorBody('VERSION_CONFLICT', { message: '다른 곳에서 먼저 바뀌었습니다.', details: { changes: s.hist.filter((h) => h.task === key).slice(-1).map((h) => ({ at: iso('2026-11-05 19:59'), actor: h.actor as string, taskKey: key, kind: h.kind as string, text: h.text as string, field: 'title', before: h.before as string, after: h.after as string })) } }));
    return false;
  };
  const t = () => s.tasks.get(key);
  api.on(`GET ${base}`, (route) => json(route, 200, detail(s, key)));
  api.on(`GET ${base}/gate`, (route) => json(route, 200, gate(s, key)));
  api.on(`GET ${base}/history`, (route) => json(route, 200, page(history(s, key))));
  api.on(`GET ${base}/attempts`, (route) => json(route, 200, page(attempts(s, key))));
  api.on(`GET ${base}/verifications`, (route) => json(route, 200, page(verifications(s, key).vs)));
  api.on(`GET ${base}/messages`, (route) => json(route, 200, page(messages(s, key))));
  api.on(`PATCH ${base}`, async (route, req) => {
    const b = req.postDataJSON() as { updatedAt: string; title?: string; priority?: number; assigneeAgent?: string; verifierAgent?: string };
    if (!(await fresh(route, b.updatedAt))) return;
    const x = t();
    const e: { kind: string; text: string; before?: string; after?: string }[] = [];
    if (b.title !== undefined) { e.push({ kind: '개요 수정', text: '제목 변경', before: x.title, after: b.title }); x.title = b.title; }
    if (b.priority !== undefined) { x.priority = b.priority; e.push({ kind: '개요 수정', text: '우선순위 변경' }); }
    if (b.assigneeAgent !== undefined) { e.push({ kind: 'Agent 변경', text: '담당 Agent 변경', before: x.assignee, after: b.assigneeAgent }); x.assignee = b.assigneeAgent; }
    if (b.verifierAgent !== undefined) { e.push({ kind: 'Agent 변경', text: '검증 Agent 변경', before: x.verifier, after: b.verifierAgent }); x.verifier = b.verifierAgent; }
    bump(s, key, e);
    await changed(route);
  });
  api.on(`PATCH ${base}/spec`, async (route, req) => {
    const b = req.postDataJSON() as { updatedAt: string; overview?: any; spec?: any; ac?: any[] };
    if (!(await fresh(route, b.updatedAt))) return;
    const x = t();
    if (b.overview) Object.assign(x, { purpose: b.overview.purpose, background: b.overview.background, scope: b.overview.scope, out: b.overview.out, precond: b.overview.precond, doneCond: b.overview.doneCond });
    if (b.spec) x.spec = { ...x.spec, ...b.spec };
    if (b.ac) x.spec = { ...x.spec, ac: b.ac };
    bump(s, key, [{ kind: '명세 수정', text: '작업 명세 수정' }]);
    await changed(route);
  });
  api.on(`PATCH ${base}/outputs`, async (route, req) => {
    const b = req.postDataJSON() as { updatedAt: string; outputs: any[] };
    if (!(await fresh(route, b.updatedAt))) return;
    t().outputs = b.outputs;
    bump(s, key, [{ kind: '명세 수정', text: '산출물 및 검증 조건 수정' }]);
    await changed(route);
  });
  for (const kind of ['DB', 'API', 'FE', 'DevOps']) {
    api.on(`PATCH ${base}/design/${kind}`, async (route, req) => {
      const b = req.postDataJSON() as { updatedAt: string; content: { ents?: unknown[]; b?: unknown } };
      if (!(await fresh(route, b.updatedAt))) return;
      const x = t();
      const rest = ((x.design ?? []) as any[]).filter((d) => d.kind !== kind);
      x.design = Object.keys(b.content).length ? [...rest, { kind, ents: b.content.ents ?? [], b: b.content.b ?? {} }] : rest;
      bump(s, key, [{ kind: '설계 수정', text: `기술 설계 ${kind} 수정` }]);
      await changed(route);
    });
  }
  api.on(`POST ${base}/checklist`, async (route, req) => {
    const b = req.postDataJSON() as { updatedAt: string; content: string; required: boolean; verifyMethod?: string };
    if (!(await fresh(route, b.updatedAt))) return;
    const x = t();
    const id = `CL-${key.slice(5)}-${String(x.checklist.length + 1)}`;
    x.checklist.push({ id, text: b.content, required: b.required, done: false, method: b.verifyMethod ?? '', evidence: '', note: '' });
    bump(s, key, [{ kind: '체크리스트', text: `${id} 항목 추가 (${b.required ? '필수' : '선택'})`, after: b.content }]);
    await changed(route, 201);
  });
  for (const c of t().checklist as any[]) {
    api.on(`PATCH ${base}/checklist/${String(c.id)}`, async (route, req) => {
      const b = req.postDataJSON() as { updatedAt: string; done?: boolean };
      if (!(await fresh(route, b.updatedAt))) return;
      const item = (t().checklist as any[]).find((x) => x.id === c.id);
      if (b.done !== undefined) item.done = b.done;
      bump(s, key, [{ kind: '체크리스트', text: `${String(c.id)} ${String(c.text)}`, before: b.done ? '미완료' : '완료', after: b.done ? '완료' : '미완료' }]);
      await changed(route);
    });
  }
  api.on(`POST ${base}/dependencies`, async (route, req) => {
    const b = req.postDataJSON() as { updatedAt: string; predTaskKey: string; depType: string };
    if (!(await fresh(route, b.updatedAt))) return;
    if (b.predTaskKey === key) return json(route, 409, errorBody('DEPENDENCY_SELF', { message: '자기 자신을 선행으로 지정할 수 없습니다.' }));
    if (s.deps.some((d) => d.pred === b.predTaskKey && d.succ === key)) return json(route, 409, errorBody('DEPENDENCY_DUPLICATE', { message: '이미 있는 선행 관계입니다.' }));
    const path = cycle(s, b.predTaskKey, key);
    if (path) return json(route, 409, errorBody('DEPENDENCY_CYCLE', { message: '이 선행 관계를 추가하면 순환 의존성이 생깁니다.', fix: '순환 경로의 관계 중 하나를 빼거나 다른 선행 Task를 고르세요.', details: { path } }));
    const dep = { id: `DEP-X${String(s.deps.length + 1)}`, pred: b.predTaskKey, succ: key, type: b.depType as 'FS' | 'SS' };
    s.deps.push(dep);
    mountDepDelete(api, s, dep.id);
    bump(s, key, [{ kind: '선행 관계', text: `선행 Task ${b.predTaskKey} 추가 (${b.depType})` }]);
    return json(route, 201, { dependency: dep, blocked: isBlocked(s, key) });
  });
  api.on(`POST ${base}/request-approval`, async (route, req) => {
    const b = req.postDataJSON() as { updatedAt: string };
    if (!(await fresh(route, b.updatedAt))) return;
    const x = t();
    if (x.status !== 'planning') return json(route, 409, errorBody('INVALID_TRANSITION', { message: '지금 상태에서는 착수 승인을 요청할 수 없습니다.' }));
    const errors = approvalErrors(detail(s, key));
    if (errors.length) return json(route, 400, errorBody('VALIDATION_FAILED', { message: '착수 승인에 필요한 명세 항목이 비어 있습니다.', fix: '표시된 항목을 채운 뒤 다시 요청하세요.', errors }));
    x.status = 'approval';
    bump(s, key, [{ kind: '승인', text: '착수 승인 요청', before: '계획 중', after: '승인 대기' }]);
    await changed(route);
  });
  for (const action of ['approve', 'reject'] as const) {
    api.on(`POST ${base}/${action}`, async (route, req) => {
      const b = req.postDataJSON() as { updatedAt: string; comment?: string };
      if (!(await fresh(route, b.updatedAt))) return;
      const x = t();
      if (x.status !== 'approval') return json(route, 409, errorBody('INVALID_TRANSITION', { message: '승인 대기 상태가 아닙니다.' }));
      x.status = action === 'approve' ? 'ready' : 'planning';
      x.approved = action === 'approve';
      bump(s, key, [{ kind: '승인', text: action === 'approve' ? '착수 승인' : `착수 반려${b.comment ? ` — ${b.comment}` : ''}`, before: '승인 대기', after: action === 'approve' ? '실행 대기' : '계획 중' }]);
      await changed(route);
    });
  }
}

function mountDepDelete(api: FakeApi, s: TaskStore, id: string): void {
  api.on(`DELETE /api/dependencies/${id}`, async (route, req) => {
    const dep = s.deps.find((d) => d.id === id);
    if (!dep) return json(route, 404, errorBody('NOT_FOUND'));
    const version = new URL(req.url()).searchParams.get('updatedAt');
    if (version !== s.version.get(dep.succ)) return json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [] } }));
    s.deps = s.deps.filter((d) => d.id !== id);
    bump(s, dep.succ, [{ kind: '선행 관계', text: `선행 Task ${dep.pred} 삭제`, before: `${dep.pred} (${dep.type})`, after: '없음' }]);
    return route.fulfill({ status: 204 });
  });
}

/** pred → … → succ 로 이미 이어지면 새 관계(pred→succ)가 순환을 만든다. 경로는 succ에서 출발 */
function cycle(s: TaskStore, pred: string, succ: string): string[] | null {
  const next = (k: string) => s.deps.filter((d) => d.pred === k).map((d) => d.succ);
  const walk = (k: string, path: string[]): string[] | null => {
    if (k === pred) return path;
    for (const n of next(k)) { if (!path.includes(n)) { const r = walk(n, [...path, n]); if (r) return r; } }
    return null;
  };
  const p = walk(succ, [succ]);
  return p ? [...p, succ] : null;
}

/** 서버 approvalErrors와 같은 문구·경로(apps/api/src/tasks/approval.ts, shared approvalReasons) */
function approvalErrors(d: Detail) {
  const e: { path: string; rule: string; message: string }[] = [];
  if (!d.spec.overview.purpose.trim()) e.push({ path: 'overview.purpose', rule: 'required', message: '작업 목적이 필요합니다.' });
  if (!d.spec.overview.doneCond.trim()) e.push({ path: 'overview.doneCond', rule: 'required', message: '완료 조건이 필요합니다.' });
  if (!d.spec.ac.length) e.push({ path: 'ac', rule: 'required', message: 'Acceptance Criteria가 1개 이상 필요합니다.' });
  if (!d.checklistItems.length) e.push({ path: 'checklist', rule: 'required', message: '체크리스트가 1개 이상 필요합니다.' });
  if (!d.outputs.some((o) => o.required)) e.push({ path: 'outputs', rule: 'required', message: '필수 산출물이 1개 이상 필요합니다.' });
  return e;
}
