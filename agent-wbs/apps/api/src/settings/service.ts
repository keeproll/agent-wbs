import type { PoolClient } from '@awbs/db';
import { DEFAULT_MEM_RESERVE_GB } from '@awbs/shared';
import { ApiError, assertSameVersion, invalid } from '../changes/http.ts';
import { canonicalJson, deferChange, iso } from '../changes/events.ts';
import { recordReplan, policyOf } from '../planning/schedule.ts';
import { githubSettings } from '../project/github.ts';
import { createCipheriv, randomBytes } from 'node:crypto';
import { RunnerRepository } from '../runner/repository.ts';
import { caps as runnerCaps, wireCaps } from '../runner/service.ts';
import { touchSetting } from './version.ts';

export interface Version { updatedAt: string | null }
export interface Split extends Version { maxHours: number; minHours: number; maxFiles: number; testIn: boolean; dir: 'layer'; on: Record<string, boolean> }
export interface Schedule extends Version { autoReplan: boolean; cpAuto: boolean; thresholdDays: number; assumeRate: number; windowDays: number; minHours: number }
export interface Blackouts extends Version { days: { date: string; note: string }[] }
export interface Concurrency extends Version { mode: 'auto' | 'manual'; caps: { total: number; Claude: number; Codex: number; heavy: number }; memReserveGB: number }
export interface Budget extends Version { budget: { dev: number; qa: number } }

const labels = { split: 'Task 분할 기준', schedule: '일정 재조정 정책', blackouts: '작업 불가일', concurrency: '동시 실행 상한', 'obs-budget': '하위 Agent 동시 예산', github: 'GitHub 연결' };
const values = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'updatedAt'));
const same = (before: object, after: object) => canonicalJson(values(before)) === canonicalJson(values(after));

/** 바뀐 설정값만 기록한다. 관측 상태와 버전은 사용자가 편집한 내용이 아니다. */
async function history(client: PoolClient, key: keyof typeof labels, before: object, after: object) {
  const project = (await client.query<{ id: string }>('select id from projects')).rows[0]?.id ?? null;
  await client.query("insert into task_history(project_id,actor,at,kind,text,before,after,ref) values($1,'팀장',clock_timestamp(),'설정',$2,$3::jsonb,$4::jsonb,$5::jsonb)",
    [project, `${labels[key]} 변경`, JSON.stringify(values(before)), JSON.stringify(values(after)), JSON.stringify({ key })]);
  deferChange(client, project, 'settings', { key });
}
async function replan(client: PoolClient, key: string) {
  const project = (await client.query<{ id: string }>('select id from projects')).rows[0]?.id;
  if (project) await recordReplan(client, project, { trigger: `${key} 설정 변경`, actor: '팀장', mode: 'policy' });
}

export async function getSplit(client: PoolClient): Promise<Split> {
  const row = (await client.query<{ split: { maxH: number; minH: number; maxFiles: number; testIn: boolean; dir: 'layer'; on: Record<string, boolean> }; updatedAt: string }>(
    `select split,${iso('split_version')} "updatedAt" from app_settings where singleton`)).rows[0];
  if (!row) throw new ApiError('UNAVAILABLE');
  const { maxH, minH, ...rest } = row.split;
  return { ...rest, maxHours: maxH, minHours: minH, updatedAt: row.updatedAt };
}
export async function putSplit(client: PoolClient, body: Split) {
  await client.query('select id from app_settings where singleton for update');
  const before = await getSplit(client);
  await assertSameVersion(client, before.updatedAt, body.updatedAt, { current: before });
  if (body.minHours > body.maxHours) throw invalid([{ path: 'minHours', rule: 'range', message: '하한은 상한 이하여야 합니다.' }]);
  if (same(before, body)) return before;
  await client.query('update app_settings set split=$1::jsonb where singleton', [JSON.stringify({ maxH: body.maxHours, minH: body.minHours, maxFiles: body.maxFiles, testIn: body.testIn, dir: body.dir, on: body.on })]);
  await touchSetting(client, 'split');
  const after = await getSplit(client);
  await history(client, 'split', before, after);
  return after;
}

export async function getSchedule(client: PoolClient): Promise<Schedule> {
  const row = (await client.query<{ cpAuto: boolean | null; updatedAt: string }>(`select cp_auto "cpAuto",${iso('settings_version')} "updatedAt" from schedule_policy where singleton`)).rows[0];
  if (!row) throw new ApiError('UNAVAILABLE');
  return { ...await policyOf(client), cpAuto: row.cpAuto ?? true, updatedAt: row.updatedAt };
}
export async function putSchedule(client: PoolClient, body: Schedule) {
  await client.query('select id from schedule_policy where singleton for update');
  const before = await getSchedule(client);
  await assertSameVersion(client, before.updatedAt, body.updatedAt, { current: before });
  if (same(before, body)) return before;
  await client.query('update schedule_policy set auto_replan=$1,cp_auto=$2,threshold_days=$3,assume_rate=$4,window_days=$5,min_hours=$6 where singleton',
    [body.autoReplan, body.cpAuto, body.thresholdDays, body.assumeRate, body.windowDays, body.minHours]);
  await touchSetting(client, 'schedule');
  const after = await getSchedule(client);
  await history(client, 'schedule', before, after);
  await replan(client, 'schedule');
  return after;
}

/** 빈 목록에도 비교할 버전이 필요하므로 불가일 묶음의 버전을 별도로 보관한다. */
export async function getBlackouts(client: PoolClient): Promise<Blackouts> {
  const days = (await client.query<{ date: string; note: string }>("select to_char(date,'YYYY-MM-DD') date,note from blackout_days order by date")).rows;
  const updatedAt = (await client.query<{ at: string }>(`select ${iso('blackouts_version')} at from app_settings where singleton`)).rows[0]?.at ?? null;
  return { days, updatedAt };
}
export async function putBlackouts(client: PoolClient, body: Blackouts) {
  await client.query('select id from app_settings where singleton for update');
  const before = await getBlackouts(client);
  await assertSameVersion(client, before.updatedAt, body.updatedAt, { current: before });
  if (new Set(body.days.map(d => d.date)).size !== body.days.length) throw invalid([{ path: 'days', rule: 'uniqueDate', message: '같은 날짜를 두 번 넣을 수 없습니다.' }]);
  if (same(before, { days: [...body.days].sort((a, b) => a.date.localeCompare(b.date)) })) return before;
  await client.query('delete from blackout_days where not(date=any($1::date[]))', [body.days.map(d => d.date)]);
  for (const day of body.days) await client.query('insert into blackout_days(date,note) values($1,$2) on conflict(date) do update set note=excluded.note', [day.date, day.note]);
  await touchSetting(client, 'blackouts');
  const after = await getBlackouts(client);
  await history(client, 'blackouts', before, after);
  await replan(client, 'blackouts');
  return after;
}

async function concurrencyRow(client: PoolClient) {
  return (await client.query<{ mode: 'auto' | 'manual'; caps: Concurrency['caps'] | null; reserve: string | null; budget: Budget['budget'] | null; concurrencyVersion: string | null; budgetVersion: string | null }>(
    `select mode,caps,mem_reserve_gb reserve,subagent_budget budget,${iso('concurrency_version')} "concurrencyVersion",${iso('budget_version')} "budgetVersion" from concurrency_settings where singleton`)).rows[0];
}
export async function getConcurrency(client: PoolClient): Promise<Concurrency> {
  const row = await concurrencyRow(client);
  const repo = new RunnerRepository(client);
  const actual = row?.mode !== 'manual' && await repo.host() ? wireCaps((await runnerCaps(repo)).caps) : null;
  return { mode: row?.mode ?? 'auto', caps: actual ?? row?.caps ?? { total: 0, Claude: 0, Codex: 0, heavy: 0 }, memReserveGB: Number(row?.reserve ?? DEFAULT_MEM_RESERVE_GB), updatedAt: row?.concurrencyVersion ?? null };
}
export async function getBudget(client: PoolClient): Promise<Budget> {
  const row = await concurrencyRow(client);
  return { budget: row?.budget ?? { dev: 0, qa: 0 }, updatedAt: row?.budgetVersion ?? null };
}
async function lockConcurrency(client: PoolClient) {
  // 새 설치에는 행이 없다. 동시 첫 저장도 같은 잠금으로 직렬화한다.
  await client.query("select pg_advisory_xact_lock(hashtextextended('settings:concurrency',0))");
  await client.query('select id from concurrency_settings where singleton for update');
}
export async function putConcurrency(client: PoolClient, body: Concurrency) {
  await lockConcurrency(client);
  const before = await getConcurrency(client);
  await assertSameVersion(client, before.updatedAt, body.updatedAt, { current: before });
  const configured = (v: Concurrency) => ({ mode: v.mode, caps: v.mode === 'manual' ? v.caps : null, memReserveGB: v.memReserveGB });
  if (same(configured(before), configured(body))) return before;
  await client.query('insert into concurrency_settings(singleton,mode,caps,mem_reserve_gb) values(true,$1,$2::jsonb,$3) on conflict(singleton) do update set mode=excluded.mode,caps=excluded.caps,mem_reserve_gb=excluded.mem_reserve_gb',
    [body.mode, JSON.stringify(body.caps), body.memReserveGB]);
  await touchSetting(client, 'concurrency');
  const after = await getConcurrency(client);
  await history(client, 'concurrency', configured(before), configured(after));
  await replan(client, 'concurrency');
  return after;
}
export async function putBudget(client: PoolClient, body: Budget) {
  await lockConcurrency(client);
  const before = await getBudget(client);
  await assertSameVersion(client, before.updatedAt, body.updatedAt, { current: before });
  if (same(before, body)) return before;
  await client.query("insert into concurrency_settings(singleton,mode,subagent_budget) values(true,'auto',$1::jsonb) on conflict(singleton) do update set subagent_budget=excluded.subagent_budget", [JSON.stringify(body.budget)]);
  await touchSetting(client, 'obs-budget');
  const after = await getBudget(client);
  await history(client, 'obs-budget', before, after);
  return after;
}

export async function putGithub(client: PoolClient, body: Version & { mode: 'gh' | 'token'; token?: string }) {
  await client.query("select pg_advisory_xact_lock(hashtextextended('settings:github',0))");
  await client.query('select id from github_settings where singleton for update');
  const before = await githubSettings(client);
  await assertSameVersion(client, before.updatedAt, body.updatedAt, { current: before });
  if (body.mode === 'token' && !body.token && !before.tokenSet) throw invalid([{ path: 'token', rule: 'required', message: '토큰 방식에는 토큰이 필요합니다.' }]);
  if (body.mode === before.mode && body.token === undefined) return before;
  if (body.token !== undefined) {
    const key = process.env.AWBS_SECRET_KEY;
    if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) throw new ApiError('UNAVAILABLE', {}, [], '비밀값 저장 키가 없습니다. AWBS_SECRET_KEY에 32바이트의 16진수 값을 설정하세요.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
    const encrypted = Buffer.concat([cipher.update(body.token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    await client.query("insert into secrets(key,ciphertext,nonce,key_version,last4) values('github-token',$1,$2,1,$3) on conflict(key) do update set ciphertext=excluded.ciphertext,nonce=excluded.nonce,key_version=excluded.key_version,last4=excluded.last4",
      [encrypted.toString('base64'), nonce.toString('base64'), body.token.slice(-4)]);
  }
  await client.query(`insert into github_settings(singleton,mode,status,secret_key) values(true,$1,'unchecked',$2)
    on conflict(singleton) do update set mode=excluded.mode,secret_key=coalesce(excluded.secret_key,github_settings.secret_key),status='unchecked',account=null,scopes=null,warning=null,expires_at=null,checked_at=null`,
  [body.mode, body.token === undefined ? null : 'github-token']);
  await touchSetting(client, 'github');
  const after = await githubSettings(client);
  await history(client, 'github', { mode: before.mode, tokenSet: before.tokenSet }, { mode: after.mode, tokenSet: after.tokenSet });
  return after;
}
