/**
 * 실제 하위 Agent v1 정의(M5-06, D-24)를 읽고 검사하고 system seed로 넣는다.
 *
 * - 정의의 원본은 `seed/subagents/`의 파일이다. DB `subagent_defs.text`에는 이 파일 내용을 그대로 넣고,
 *   Runner는 그 내용을 worktree의 `.claude/agents/`·`.codex/agents/`에 설치한다(G §7.4-3).
 * - hash는 파일 내용(UTF-8 바이트)의 sha256 16진수다. Runner가 받은 `file`로 같은 값을 다시 계산해 비교할 수 있다.
 * - 모델·effort는 정의에 적지 않는다. Runner가 설치할 때 실행 정책 등급으로 채운다(G §7.4).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from './pool.ts';

export type SubagentAgent = 'Claude' | 'Codex';

export interface SubagentDefFile {
  key: string;
  version: number;
  agent: SubagentAgent;
  role: string;
  tools: string[];
  sandbox: string;
  allowed: boolean;
  ref: string | null;
  file: string;
  hash: string;
  /** `file`의 실제 내용. */
  text: string;
}

export interface SubagentSet {
  defs: SubagentDefFile[];
  /** 모든 정의에 똑같이 들어가야 하는 공통 규칙 블록(`common-rules.md`). */
  common: string;
  /** 검토 기록(`REVIEW.md`). 정의·버전·hash마다 한 줄이 있어야 한다. */
  review: string;
}

export type SubagentRule =
  | 'format' | 'name' | 'hash' | 'version' | 'review' | 'model-effort'
  | 'config-key' | 'tools' | 'mock-text' | 'conflict' | 'common-rules';

export interface SubagentIssue { key: string; rule: SubagentRule; message: string }

export interface MockSubagent { id: string; text: string }

const DIR = new URL('../seed/subagents/', import.meta.url);

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export async function loadSubagentSet(dir: URL = DIR): Promise<SubagentSet> {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8')) as { defs: Omit<SubagentDefFile, 'text'>[] };
  const defs = await Promise.all(manifest.defs.map(async (d) => ({ ...d, text: await readFile(new URL(d.file, dir), 'utf8') })));
  return {
    defs,
    common: await readFile(new URL('common-rules.md', dir), 'utf8'),
    review: await readFile(new URL('REVIEW.md', dir), 'utf8'),
  };
}

/** 원본 P `SUB_MOCK` 정의. demo seed가 쓰는 같은 fixture(`seed/demo.json`)에서 읽는다. */
export async function loadMockSubagents(): Promise<MockSubagent[]> {
  const demo = JSON.parse(await readFile(new URL('../seed/demo.json', import.meta.url), 'utf8')) as { sub: { defs: MockSubagent[] } };
  return demo.sub.defs.map((d) => ({ id: d.id, text: d.text }));
}

/* ───────────── 파일 읽기(허용한 모양만) ───────────── */

interface Parsed { name?: string; description?: string; keys: string[]; tools?: string[]; sandboxMode?: string; instructions: string }

/** Claude: `---` 사이 `키: 값` 줄 + 본문. 여러 줄 값·목록은 허용하지 않는다(검사가 못 보는 설정이 숨지 않게). */
function parseClaude(text: string): Parsed | string {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return '파일이 `---` frontmatter로 시작하지 않습니다.';
  const out: Parsed = { keys: [], instructions: m[2] ?? '' };
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (!kv) return `frontmatter 줄을 읽을 수 없습니다: ${line}`;
    const [, key = '', value = ''] = kv;
    out.keys.push(key);
    if (key === 'name') out.name = value.trim();
    if (key === 'description') out.description = value.trim();
    if (key === 'tools') out.tools = value.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return out;
}

/**
 * Codex: `키 = "문자열"` 줄과 `developer_instructions = """ … """`만 허용한다.
 * 역슬래시는 TOML 이스케이프라 저장한 글자와 실제 지시가 달라질 수 있어 금지한다.
 */
function parseCodex(text: string): Parsed | string {
  if (text.includes('\\')) return 'TOML에 역슬래시(\\)를 쓸 수 없습니다.';
  const out: Parsed = { keys: [], instructions: '' };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.startsWith('#')) continue;
    const multi = /^([A-Za-z_][\w-]*) = """$/.exec(line);
    if (multi) {
      const end = lines.indexOf('"""', i + 1);
      if (end < 0) return `${multi[1] ?? ''}의 """ 끝을 찾을 수 없습니다.`;
      const value = lines.slice(i + 1, end).join('\n');
      out.keys.push(multi[1] ?? '');
      if (multi[1] === 'developer_instructions') out.instructions = value;
      i = end;
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*) = "([^"]*)"$/.exec(line);
    if (!kv) {
      const key = /^\[?\s*([A-Za-z_][\w.-]*)/.exec(line)?.[1];
      if (key) { out.keys.push(key); continue; } // 키 이름은 config-key 검사가 잡는다.
      return `TOML 줄을 읽을 수 없습니다: ${line}`;
    }
    const [, key = '', value = ''] = kv;
    out.keys.push(key);
    if (key === 'name') out.name = value.trim();
    if (key === 'description') out.description = value.trim();
    if (key === 'sandbox_mode') out.sandboxMode = value;
  }
  return out;
}

/* ───────────── 규칙 ───────────── */

const KEY = /^[a-z][a-z0-9-]{1,62}$/;
const CLAUDE_KEYS = new Set(['name', 'description', 'tools']);
const CODEX_KEYS = new Set(['name', 'description', 'sandbox_mode', 'developer_instructions']);
const MODEL_KEYS = new Set(['model', 'effort', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'model_provider', 'reasoning_effort']);
const MODEL_TEXT = /claude-(haiku|sonnet|opus|fable)|\bgpt-\d|\bo\d-(mini|pro)\b|model_reasoning_effort|\beffort\s*[:=]/i;
/** Claude 도구 허용 목록. 하위 Agent를 더 띄우는 Agent·Task, 외부 접속 WebFetch·WebSearch, MCP 도구는 뺀다. */
const CLAUDE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
const CLAUDE_WRITE = new Set(['Edit', 'Write', 'Bash']);
/** Codex 도구 표기. 실제 권한은 sandbox_mode가 정한다. */
const CODEX_TOOLS = new Set(['shell', 'apply_patch']);
const SANDBOX: Record<string, string> = { 'read-only': '읽기 전용', 'workspace-write': 'worktree 쓰기' };

/**
 * 일반 정의에 고정하면 안 되는 지시(D-24)와 승인된 정책과 맞지 않는 지시다.
 * 하나라도 있으면 `conflict`로 잡는다.
 */
export const CONFLICT_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\b(React|Mantine|Vite|Fastify|Drizzle|pnpm|vitest|playwright|PostgreSQL|Postgres)\b/i, why: '관리 대상 스택을 정의에 고정했습니다(D-24). 스택은 Task 지시문이 정합니다.' },
  { pattern: /packages\/shared|Main\.dc\.html|설계 문서 \d+장/, why: '특정 저장소 경로·원본 문서를 정의에 고정했습니다(D-24).' },
  { pattern: /\bdown\b.{0,12}migration|되돌리기\s*\(down\)|up\s*→\s*down/i, why: 'down migration은 채택하지 않았습니다(data-model §6, P TASK-0004는 Mock 요구).' },
  { pattern: /evidence\/<|\bfence\b|VERSION_CONFLICT|\b409\b|\/api\/runner|runner_|Runner 토큰/i, why: 'Runner 계약 전용 지시를 일반 정의에 넣었습니다(D-24).' },
  { pattern: /awesome-(claude-code|codex)-subagents|VoltAgent/i, why: '외부 하위 Agent 모음은 참고만 하고 설치하지 않습니다(G §7.4, D-24).' },
  { pattern: /~\/\.(claude|codex)|\$HOME\/\.(claude|codex)/, why: '사용자 전체 폴더에는 설치하지 않습니다(G §7.4-3).' },
  { pattern: /결함으로 등록|defects?\s*등록/i, why: '결함 등록은 부모 세션 보고로 합니다. 하위 Agent가 직접 기록하지 않습니다.' },
];

/** Mock 문장을 옮겨 왔는지 보려고, 공백·문장 부호를 지운 12자 이상 조각으로 비교한다. */
const norm = (s: string) => s.replace(/[\s·.,:;()\-「」"'`]/g, '');
function mockSentences(mock: readonly MockSubagent[]): string[] {
  return mock.flatMap((m) => m.text.split(/\n|(?<=다\.)\s*/)).map(norm).filter((s) => s.length >= 12);
}

export function checkSubagentSet(set: SubagentSet, mock: readonly MockSubagent[]): SubagentIssue[] {
  const issues: SubagentIssue[] = [];
  const add = (key: string, rule: SubagentRule, message: string) => issues.push({ key, rule, message });
  const mockIds = new Set(mock.map((m) => m.id));
  const sentences = mockSentences(mock);
  const seen = new Set<string>();

  for (const d of set.defs) {
    const k = d.key;
    if (!KEY.test(k)) add(k, 'name', '정의 이름은 소문자·숫자·하이픈만 씁니다.');
    if (!d.role.trim()) add(k, 'name', '역할이 비었습니다.');

    // hash·버전
    if (!/^[a-f0-9]{64}$/.test(d.hash) || sha256Hex(d.text) !== d.hash) add(k, 'hash', `manifest hash와 파일 내용의 sha256이 다릅니다(${d.file}).`);
    if (!Number.isInteger(d.version) || d.version < 1) add(k, 'version', '버전은 1 이상의 정수입니다.');
    const ext = d.agent === 'Claude' ? 'md' : 'toml';
    const folder = d.agent === 'Claude' ? 'claude' : 'codex';
    if (d.file !== `${folder}/${k}.v${String(d.version)}.${ext}`) add(k, 'version', `파일 이름이 ${folder}/${k}.v${String(d.version)}.${ext}이어야 합니다(버전마다 파일을 따로 둡니다).`);
    const id = `${k}@${String(d.version)}`;
    if (seen.has(id)) add(k, 'version', `같은 정의·버전이 두 번 있습니다(${id}).`);
    seen.add(id);
    if (!set.review.includes(`\`${k}\` v${String(d.version)} \`${d.hash}\``)) add(k, 'review', `REVIEW.md에 \`${k}\` v${String(d.version)}과 현재 hash의 검토 기록이 없습니다.`);

    // 파일 모양
    const parsed = d.agent === 'Claude' ? parseClaude(d.text) : parseCodex(d.text);
    if (typeof parsed === 'string') { add(k, 'format', parsed); continue; }
    if (parsed.name !== k) add(k, 'name', `파일 안 name(${parsed.name ?? '없음'})이 정의 이름과 다릅니다.`);
    if (!parsed.description) add(k, 'name', 'description이 비었습니다. CLI가 언제 이 정의를 쓸지 판단하는 데 필요합니다.');

    // 모델·effort와 허용 키
    const allowedKeys = d.agent === 'Claude' ? CLAUDE_KEYS : CODEX_KEYS;
    for (const key of parsed.keys) {
      if (MODEL_KEYS.has(key)) add(k, 'model-effort', `모델·effort 설정(${key})은 정의에 적지 않습니다.`);
      else if (!allowedKeys.has(key)) add(k, 'config-key', `허용하지 않은 설정 키입니다: ${key}`);
    }
    if (new Set(parsed.keys).size !== parsed.keys.length) add(k, 'format', '같은 설정 키가 두 번 있습니다.');
    if (MODEL_TEXT.test(parsed.instructions) || MODEL_TEXT.test(parsed.description ?? '')) add(k, 'model-effort', '지시문에 모델 이름이나 effort를 적었습니다.');

    // 도구·권한
    if (d.agent === 'Claude') {
      const fileTools = parsed.tools ?? [];
      if (fileTools.join(',') !== d.tools.join(',')) add(k, 'tools', `파일의 tools(${fileTools.join(', ')})와 manifest tools(${d.tools.join(', ')})가 다릅니다.`);
      for (const t of new Set([...fileTools, ...d.tools])) if (!CLAUDE_TOOLS.has(t)) add(k, 'tools', `허용하지 않은 도구입니다: ${t}`);
      const writes = fileTools.some((t) => CLAUDE_WRITE.has(t));
      if (writes !== d.sandbox.startsWith('worktree 쓰기')) add(k, 'tools', `권한 표시(${d.sandbox})가 도구와 맞지 않습니다. 쓰기·명령 도구가 있으면 「worktree 쓰기」, 없으면 「읽기 전용」입니다.`);
      if (!writes && d.sandbox !== '읽기 전용') add(k, 'tools', '읽기 전용 정의의 권한 표시는 「읽기 전용」입니다.');
    } else {
      const label = SANDBOX[parsed.sandboxMode ?? ''];
      if (!label) add(k, 'config-key', `sandbox_mode는 read-only 또는 workspace-write만 씁니다(${parsed.sandboxMode ?? '없음'}).`);
      else if (!d.sandbox.startsWith(label) || (label === '읽기 전용' && d.sandbox !== label)) add(k, 'tools', `권한 표시(${d.sandbox})가 sandbox_mode(${parsed.sandboxMode ?? ''})와 맞지 않습니다.`);
      for (const t of d.tools) if (!CODEX_TOOLS.has(t)) add(k, 'tools', `허용하지 않은 도구입니다: ${t}`);
      if (!d.tools.includes('shell')) add(k, 'tools', 'Codex 정의에는 shell이 있어야 합니다.');
      if (d.tools.includes('apply_patch') !== (parsed.sandboxMode === 'workspace-write')) add(k, 'tools', 'apply_patch는 workspace-write 정의에만 씁니다.');
    }

    // Mock과 충돌 지시
    if (mockIds.has(k)) add(k, 'mock-text', `Mock 정의 이름(${k})을 그대로 썼습니다. demo 정의와 섞이지 않게 다른 이름을 씁니다.`);
    const body = norm(d.text);
    for (const s of sentences) if (body.includes(s)) { add(k, 'mock-text', `SUB_MOCK 문장을 그대로 옮겼습니다: ${s.slice(0, 30)}…`); break; }
    for (const c of CONFLICT_PATTERNS) {
      const hit = c.pattern.exec(d.text);
      if (hit) add(k, 'conflict', `${c.why} (「${hit[0]}」)`);
    }

    // 공통 규칙: 블록 전체가 줄 단위로 그대로 있어야 한다.
    const common = set.common.trimEnd();
    if (!parsed.instructions.includes(common)) add(k, 'common-rules', '공통 규칙 블록(common-rules.md)이 빠졌거나 바뀌었습니다.');
  }
  return issues;
}

/* ───────────── system seed ───────────── */

/**
 * 검사를 통과한 정의만 넣는다. 이미 있는 정의·버전은 건드리지 않는다(팀장이 바꾼 허용 값을 덮지 않기 위해).
 * 같은 정의·버전인데 hash가 다르면 멈춘다. 버전은 불변이므로 내용을 바꾸려면 새 버전을 더해야 한다.
 */
export async function seedSubagents(pool: Pool, set?: SubagentSet): Promise<void> {
  const defs = set ?? await loadSubagentSet();
  const issues = checkSubagentSet(defs, await loadMockSubagents());
  if (issues.length) throw new Error(`하위 Agent 정의 검사 실패: ${issues.map((i) => `${i.key} ${i.rule} ${i.message}`).join(' / ')}`);
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const d of defs.defs) {
      const found = (await client.query<{ hash: string; is_demo: boolean }>('select hash,is_demo from subagent_defs where def_key=$1 and version=$2 for update', [d.key, d.version])).rows[0];
      if (found) {
        if (found.is_demo || found.hash !== d.hash) throw new Error(`하위 Agent 정의 ${d.key} v${String(d.version)}가 이미 다른 내용으로 있습니다. 이미 넣은 버전은 바꿀 수 없으니 새 버전을 더하세요.`);
        continue;
      }
      await client.query(
        'insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash,allowed,is_demo,ref) values($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10)',
        [d.key, d.version, d.agent, d.role, d.tools, d.sandbox, d.text, d.hash, d.allowed, d.ref],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
