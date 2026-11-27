/**
 * 실제 API·실제 DB(demo seed: 원본 Mock과 같은 Task 12건)로 WBS 화면을 확인한다. `pnpm --filter @awbs/web e2e:api-wbs`가 환경을 만든다.
 * - WBS 표·레일이 서버 데이터로 그려진다.
 * - UAT-WIZ-02: 없는 Work Package로 만든 생성 요청은 서버가 4xx로 거부하고 부분 생성이 없다.
 * - 시나리오 1(생성 부분): Wizard → 서버에 Task·선행(FS) 생성 → 차단 표시.
 * - UAT-WBS-05: 200·1,000행에서 서버 응답(listTasks·getSchedule)과 첫 행 표시 시간을 잰다.
 * 환경 변수가 없으면(일반 `W e2e`) 건너뛴다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const password = process.env.AWBS_E2E_PASSWORD ?? '';
const api = process.env.AWBS_E2E_API ?? '';
test.skip(!password || !api, '실제 API 환경이 없다. pnpm --filter @awbs/web e2e:api-wbs로 실행한다.');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 } });

const PG = process.env.AWBS_E2E_PG_CONTAINER ?? '';
const OUT = process.env.AWBS_PERF_OUT ?? join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M3-02/perf');
const serverErrors: string[] = [];

async function login(page: Page) {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
  await page.goto('/login');
  const status = await page.evaluate(async (pw) => (await fetch('/api/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'password', password: pw }) })).status, password);
  expect(status).toBe(204);
}

/** 브라우저 안에서 API를 부른다(Origin·CSRF가 화면과 같다). */
async function call(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; ms: number }> {
  return page.evaluate(async ({ method, path, body }) => {
    const session = await (await fetch('/api/session')).json() as { csrfToken: string };
    const t0 = performance.now();
    const r = await fetch(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-csrf-token': session.csrfToken, ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) as unknown : null, ms: Math.round(performance.now() - t0) };
  }, { method, path, body });
}

interface ListBody { nodes: { id: string; kind: string; wbsPath: string }[]; tasks: { taskKey: string; blocked: boolean; preds: string[] }[] }
let projectId = '';

test.afterAll(() => { if (serverErrors.length) console.log(`[실제 API 5xx] ${serverErrors.join(' | ')}`); });

test('실제 서버의 WBS: 12건 표·일정 요약·레일+상세', async ({ page }) => {
  await login(page);
  const project = (await call(page, 'GET', '/api/project')).json as { id: string; state: string };
  expect(project.state).toBe('active');
  projectId = project.id;
  await page.goto('/wbs');
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  await expect(page.locator('.page-sub').first()).toContainText('12 Tasks · 완료 3');
  await expect(page.locator('.sch-sub')).toContainText('완료 예상');
  const table = page.getByRole('table', { name: 'WBS Task 목록' });
  await table.getByRole('button', { name: 'Drizzle Schema 설계' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0004');
  await expect(page.getByRole('region', { name: 'Task 상세' })).toContainText('4 / 12');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '일정 (Gantt)' }).click();
  await expect(page.getByRole('table', { name: 'WBS 일정 (Gantt)' }).locator('.g-row.task')).not.toHaveCount(0);
  expect(serverErrors).toEqual([]);
});

test('UAT-WIZ-02 없는 Work Package로 생성 요청 → 서버 4xx, 부분 생성 없음', async ({ page }) => {
  await login(page);
  const before = (await call(page, 'GET', `/api/projects/${projectId}/tasks`)).json as ListBody;
  const phase = before.nodes.find((n) => n.kind === 'phase');
  const body = { title: '없는 WP', workType: 'Design', primaryDomain: 'API', overview: { purpose: 'p', background: '', scope: [], out: [], precond: '', doneCond: 'd' } };
  const missing = await call(page, 'POST', `/api/projects/${projectId}/tasks`, { ...body, wbsNodeId: '00000000-0000-4000-8000-000000000000' });
  expect(missing.status).toBe(404);
  expect((missing.json as { error: { code: string } }).error.code).toBe('WBS_NODE_NOT_FOUND');
  // Phase(Work Package가 아닌 노드) 아래에도 만들 수 없다.
  const notWp = await call(page, 'POST', `/api/projects/${projectId}/tasks`, { ...body, wbsNodeId: phase?.id });
  expect(notWp.status).toBe(404);
  const after = (await call(page, 'GET', `/api/projects/${projectId}/tasks`)).json as ListBody;
  expect(after.tasks.map((t) => t.taskKey)).toEqual(before.tasks.map((t) => t.taskKey));
  // 화면도 오류 없이 그대로다.
  await page.goto('/wbs');
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
});

test('시나리오 1(생성): Wizard로 만든 Task와 선행(FS)이 서버에 저장되고 차단으로 보인다', async ({ page }) => {
  await login(page);
  await page.goto('/wbs');
  await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
  const w = page.getByRole('dialog', { name: 'Task 생성' });
  await w.getByLabel('Task 제목').fill('실제 서버 생성 시험');
  await w.getByLabel('상위 Work Package').selectOption({ label: '2.1 Task API' });
  await w.getByRole('group', { name: '작업 유형' }).getByRole('button', { name: /구현/ }).click();
  await w.getByRole('group', { name: '주 기술 영역' }).getByRole('button', { name: /^BE/ }).click();
  await w.getByRole('button', { name: '다음' }).click();
  await w.getByLabel('작업 목적').fill('목적');
  await w.getByLabel('완료 조건').fill('완료 조건');
  await w.getByRole('button', { name: '다음' }).click();
  await w.getByRole('group', { name: '선행 Task' }).locator('label').filter({ hasText: 'TASK-0005' }).getByRole('checkbox').check();
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  await expect(page).toHaveURL(/\/wbs\/TASK-0013\?tab=spec$/);
  await expect(page.getByRole('region', { name: 'Task 상세' }).getByRole('heading', { level: 2 })).toHaveText('실제 서버 생성 시험');
  const list = (await call(page, 'GET', `/api/projects/${projectId}/tasks`)).json as ListBody;
  const created = list.tasks.find((t) => t.taskKey === 'TASK-0013');
  expect(created).toMatchObject({ preds: ['TASK-0005'], blocked: true });
  await page.getByRole('button', { name: '펼치기', exact: true }).click();
  await expect(page.getByRole('table', { name: 'WBS Task 목록' }).locator('.trow.task').filter({ has: page.locator('.td.tcell > .tid', { hasText: 'TASK-0013' }) })).toContainText('차단 · TASK-0005');
  expect(serverErrors).toEqual([]);
});

test('독립 리뷰 #1·재리뷰 F1(실제 DB): 고른 선행이 지워지면 Task는 하나만 생기고, 그 선행을 해제해 남은 선행을 연결한다', async ({ page }) => {
  await login(page);
  const body = { workType: 'Design', primaryDomain: 'API', overview: { purpose: 'p', background: '', scope: [], out: [], precond: '', doneCond: 'd' } };
  const list0 = (await call(page, 'GET', `/api/projects/${projectId}/tasks`)).json as ListBody;
  const wp = list0.nodes.find((n) => n.kind === 'work_package');
  const victim = (await call(page, 'POST', `/api/projects/${projectId}/tasks`, { ...body, title: '지워질 선행', wbsNodeId: wp?.id })).json as { taskKey: string };
  await page.goto('/wbs');
  await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
  const w = page.getByRole('dialog', { name: 'Task 생성' });
  await w.getByLabel('Task 제목').fill('중복 금지 시험');
  await w.getByRole('group', { name: '작업 유형' }).getByRole('button', { name: /설계/ }).click();
  await w.getByRole('group', { name: '주 기술 영역' }).getByRole('button', { name: /^API/ }).click();
  await w.getByRole('button', { name: '다음' }).click();
  await w.getByLabel('작업 목적').fill('p');
  await w.getByLabel('완료 조건').fill('d');
  await w.getByRole('button', { name: '다음' }).click();
  const group = w.getByRole('group', { name: '선행 Task' });
  await group.locator('label').filter({ hasText: victim.taskKey }).getByRole('checkbox').check();
  await group.locator('label').filter({ hasText: 'TASK-0005' }).getByRole('checkbox').check();
  // 선택한 뒤 다른 곳에서 그 Task를 정상 삭제한다.
  const v = (await call(page, 'GET', `/api/tasks/${victim.taskKey}`)).json as { updatedAt: string };
  expect((await call(page, 'DELETE', `/api/tasks/${victim.taskKey}?updatedAt=${encodeURIComponent(v.updatedAt)}`)).status).toBe(204);
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  await expect(w).toContainText('을(를) 이미 만들었습니다');
  await expect(page.getByRole('alert').filter({ hasText: '선행 Task를 연결하지 못했습니다' })).toBeVisible();
  // 목록을 다시 읽으면 지워진 선행은 「목록에 없음」으로 남는다 → 해제 → 남은 TASK-0005 연결
  const gone = group.locator('label').filter({ hasText: victim.taskKey });
  await expect(gone).toContainText('목록에 없음');
  await gone.getByRole('checkbox').click();
  await expect(gone).toHaveCount(0);
  await w.getByRole('button', { name: '선행 연결', exact: true }).click();
  await expect(page).toHaveURL(/\/wbs\/TASK-\d+\?tab=spec$/);
  const key = new URL(page.url()).pathname.split('/')[2] ?? '';
  const after = (await call(page, 'GET', `/api/projects/${projectId}/tasks`)).json as { tasks: { taskKey: string; title: string; preds: string[] }[] };
  expect(after.tasks.filter((t) => t.title === '중복 금지 시험')).toHaveLength(1);
  expect(after.tasks.find((t) => t.taskKey === key)?.preds).toEqual(['TASK-0005']);
});

test('UAT-WBS-05 실제 서버 200·1,000행: 응답 시간과 첫 행 표시 시간을 기록한다', async ({ page }) => {
  test.setTimeout(1_200_000);
  await login(page);
  const rows: Record<string, unknown>[] = [];
  const at = new Date().toISOString();
  const save = () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'wbs-perf-api.json'), `${JSON.stringify({ at, env: '실제 API(LAN 모드, 같은 PC)·전용 PostgreSQL 16 컨테이너, vite preview 프록시, Chromium headless 1920×1080', rows }, null, 2)}\n`);
    writeFileSync(join(OUT, 'wbs-perf-api.md'), [
      `# WBS 대량 목록 — 실제 API 측정 (${at})`, '',
      '- 환경: 실제 API(LAN 모드, 같은 PC) + 전용 PostgreSQL 16 컨테이너(demo seed 12건에 Task를 더 만들어 200·1,000건), vite preview 프록시, Chromium headless 1920×1080.',
      '- 응답 시간은 브라우저 fetch 기준 3회(화면의 10초 제한 없이 끝까지 기다림). 화면은 /wbs 이동부터 첫 행·「전체 n건」 표시까지(화면 요청은 10초 제한).',
      '- Task 생성은 동시 8개로 보냈다(준비 시간 단축). 생성 시간은 참고값이다. 1,000행은 API로 만든 행을 복사해 전용 DB에 직접 넣었다(800건을 API로 만들면 20분 넘게 걸려 측정 대상에서 뺌).',
      '- 「동시 생성 500」: 같은 Work Package에 동시에 만들 때 서버가 500 INTERNAL을 준 수(서버 결함, 보고). 그 요청은 끝난 뒤 하나씩 다시 보내 채웠다.', '',
      '| 행 수 | 동시 생성 500 | Task 생성 중앙값(ms) | listTasks 3회(ms) | listTasks 응답 크기(byte) | getSchedule 3회(ms) | 화면 결과 | 화면 첫 행(ms) | 그린 DOM 행 |',
      '|---:|---:|---:|---|---:|---|---|---:|---:|',
      ...rows.map((r) => `| ${String(r.rows)} | ${String(r.concurrentCreate500)} | ${String(r.createTaskMedianMs)} | ${(r.listTasksMs as number[]).join(' · ')} | ${String(r.listBytes)} | ${(r.scheduleMs as number[]).join(' · ')} | ${String(r.screen)} | ${String(r.screenFirstRowMs)} | ${String(r.domRows)} |`),
      '',
    ].join('\n'));
  };
  const list = (await call(page, 'GET', `/api/projects/${projectId}/tasks`)).json as ListBody;
  const wps = list.nodes.filter((n) => n.kind === 'work_package').map((n) => n.id);
  let count = list.tasks.length;
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)] ?? 0); };
  for (const target of [200, 1000]) {
    // 1,000행: API로 만든 Task 한 행을 복사해 전용 DB에 직접 넣는다(읽기 측정용, 생성 측정 아님).
    if (target > 200 && PG) {
      const sql = `insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state)
        select t.project_id,'TASK-'||(10000+g),t.wbs_node_id,100000+g,'대량 Task '||g,t.work_type,t.primary_domain,t.related_domains,t.priority,t.assignee_agent,t.verifier_agent,t.status,t.verif_state
        from (select * from tasks where title='대량 Task 200' limit 1) t, generate_series(${String(count + 1)},${String(target)}) g;
        insert into task_specs(project_id,task,overview,spec,ac,revision) select s.project_id,t.id,s.overview,s.spec,s.ac,1 from tasks t
          cross join (select project_id,overview,spec,ac from task_specs where task=(select id from tasks where title='대량 Task 200' limit 1)) s
          where t.sort_order>100000;`;
      execFileSync('docker', ['exec', PG, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'awbs_owner', '-d', 'awbs_test_m302', '-c', sql], { stdio: 'pipe' });
    }
    // 서버에 Task를 채운다(Work Package에 고르게, 동시 8개).
    const made = target > 200 && PG ? { errors: [] as string[], times: [] as number[], concurrent500: [] as string[] } : await page.evaluate(async ({ projectId, wps, from, to }) => {
      const session = await (await fetch('/api/session')).json() as { csrfToken: string };
      const times: number[] = [];
      const errors: string[] = [];
      /** 동시 생성에서 서버가 500을 준 요청(서버 결함 보고용). 끝난 뒤 하나씩 다시 보낸다. */
      const concurrent500: string[] = [];
      const retry: number[] = [];
      const create = async (i: number) => {
        const t0 = performance.now();
        const r = await fetch(`/api/projects/${projectId}/tasks`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ title: `대량 Task ${String(i + 1)}`, wbsNodeId: wps[i % wps.length], workType: 'Implementation', primaryDomain: i % 2 ? 'FE' : 'BE', overview: { purpose: 'p', background: '', scope: [], out: [], precond: '', doneCond: 'd' } }),
        });
        times.push(performance.now() - t0);
        return r;
      };
      let next = from;
      const worker = async () => {
        while (next < to) {
          const i = next++;
          const r = await create(i);
          if (r.status !== 201) { concurrent500.push(`${String(r.status)} ${(JSON.parse(await r.text()) as { error: { code: string; requestId: string } }).error.code}`); retry.push(i); }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      for (const i of retry) {
        const r = await create(i);
        if (r.status !== 201) errors.push(`${String(r.status)} ${await r.text()}`);
      }
      return { errors, times, concurrent500 };
    }, { projectId, wps, from: count, to: target });
    expect(made.errors).toEqual([]);
    count = target;
    const listMs: number[] = [];
    const schedMs: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      const l = await call(page, 'GET', `/api/projects/${projectId}/tasks`);
      expect(l.status).toBe(200);
      expect((l.json as ListBody).tasks).toHaveLength(target);
      bytes = JSON.stringify(l.json).length;
      listMs.push(l.ms);
      const s = await call(page, 'GET', '/api/schedule');
      expect(s.status).toBe(200);
      schedMs.push(s.ms);
    }
    const t0 = Date.now();
    await page.goto('/wbs');
    const ok = page.locator('.resbar').filter({ hasText: `전체 ${String(target)}건` });
    const failed = page.getByRole('region', { name: 'WBS 화면을 불러오지 못했습니다' });
    await expect(ok.or(failed)).toBeVisible({ timeout: 30_000 });
    const screenMs = Date.now() - t0;
    let screen = '표시';
    let domRows: number | string = '—';
    if (await failed.isVisible()) {
      screen = `불러오기 실패: ${(await failed.locator('p').first().textContent()) ?? ''}`;
    } else {
      domRows = await page.getByRole('table', { name: 'WBS Task 목록' }).locator('.trow:not(.thead)').count();
      await page.evaluate(() => { const el = document.querySelector('.wbs .tbl'); if (el) el.scrollTop = el.scrollHeight; });
      await expect(async () => {
        await page.evaluate(() => { const el = document.querySelector('.wbs .tbl'); if (el) el.scrollTop = el.scrollHeight; });
        await expect(page.locator('.wbs .tbl .trow.task').last()).toBeInViewport();
      }).toPass();
    }
    rows.push({ rows: target, concurrentCreate500: made.concurrent500.length, createTaskMedianMs: median(made.times), listTasksMs: listMs, listTasksMedianMs: median(listMs), listBytes: bytes, scheduleMs: schedMs, scheduleMedianMs: median(schedMs), screen, screenFirstRowMs: screenMs, domRows });
    save();
  }
  // 200행은 화면에 표시되어야 한다. 1,000행 결과는 기록만 한다(서버 응답 시간 문제는 보고 대상).
  expect(rows[0]?.screen).toBe('표시');
});
