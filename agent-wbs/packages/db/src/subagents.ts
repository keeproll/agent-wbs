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
import { parse as parseToml } from 'smol-toml';
import { isAlias, isMap, isScalar, Lexer, parseAllDocuments, visit } from 'yaml';
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
  /** 파일을 UTF-8로 엄격하게 읽지 못했을 때의 이유. 있으면 format 오류다. */
  encodingError?: string;
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
  const defs = await Promise.all(manifest.defs.map(async (d) => {
    const decoded = decodeUtf8Strict(await readFile(new URL(d.file, dir)));
    return { ...d, text: decoded.text, ...(decoded.error ? { encodingError: decoded.error } : {}) };
  }));
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

/* ───────────── 파일 읽기 ───────────── */

/*
 * 기준: 검사기는 CLI(Claude Code·Codex)가 실제로 읽는 방식보다 관대하면 안 된다(리뷰 P2-3, 재리뷰).
 * 그래서 손으로 만든 해석 대신 표준 분석기를 쓴다.
 *   - Claude frontmatter: YAML 1.2 엄격 분석(`yaml` 패키지, strict·uniqueKeys). 경고도 오류로 본다.
 *   - Codex 역할 파일: TOML 분석기(`smol-toml` 1.9.1, 공식 설명상 TOML 1.1.0 지원). Codex도 실제 TOML 분석기(Rust `toml` crate)로 읽는다.
 * 분석 전에 파일 자체를 먼저 거른다: UTF-8로 읽을 수 없는 바이트, 맨 앞 BOM, 탭·LF 밖의 제어 문자, 비문자.
 */

/**
 * 분석기가 해석한 결과. 정책 검사(conflict·mock-text·model-effort·tools·common-rules)는 모두 이 값에 적용한다.
 * - `visible`: CLI가 실제로 보게 될 문자열 전부(설정 값과 지시문 본문). 이스케이프·여러 줄 문자열·리터럴 문자열을 해석한 뒤의 값이다.
 * - 파일 원문은 인코딩·문자(바이트 수준) 검사와 hash에만 쓴다.
 *   왜: 원문만 보면 `Re\u0061ct`처럼 이스케이프로 적은 글자를 놓친다. CLI는 해석한 값 `React`를 받는다(3차 리뷰 P2).
 */
interface Parsed { name?: string; description?: string; keys: string[]; tools?: string[]; instructions: string; visible: string[] }

/** TOML 값 안의 문자열을 모두 모은다(표·배열 안의 문자열 포함). */
function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [k, ...stringLeaves(v)]);
  return [];
}

/** 파일 바이트를 UTF-8로 엄격하게 읽는다. 잘못된 바이트를 U+FFFD로 바꾸지 않고 오류를 돌려준다. BOM도 지우지 않는다. */
export function decodeUtf8Strict(bytes: Uint8Array): { text: string; error?: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), error: '파일을 UTF-8로 읽을 수 없습니다(잘못된 바이트 순서).' };
  }
}

/**
 * 정의 파일에 쓸 수 있는 문자만 남았는지 본다(바이트·문자 수준 검사). 허용 범위는 다음뿐이다.
 *   - 탭(U+0009)과 LF(U+000A)
 *   - U+0020~U+007E, U+00A0~U+D7FF, U+E000~U+FFFD(U+FEFF 제외), U+10000 이상
 * 표준과 제품 규칙을 구분해 적는다.
 *   - 표준이 거부하는 것:
 *     - C0 제어 문자(탭·LF·CR 제외)와 DEL(U+007F)은 YAML 1.2 §5.1과 TOML이 모두 거부한다.
 *     - U+0080~U+0084, U+0086~U+009F와 U+FFFE·U+FFFF는 YAML 1.2 §5.1이 거부한다. TOML은 받는다.
 *   - 제품 규칙(표준보다 좁힘):
 *     - U+0085(NEL)는 YAML 1.2가 받고 TOML도 받지만, C1 범위를 통째로 막는다. 줄바꿈처럼 보이는 글자가 화면·diff에서 숨지 않게 하려는 것이다.
 *     - CR(U+000D)은 두 표준 모두 받지만 막는다. 줄 끝 방식에 따라 hash가 달라지지 않게 LF만 쓴다.
 *     - 맨 앞 BOM(U+FEFF)과 중간의 U+FEFF도 막는다. CLI마다 BOM 처리가 달라 같은 파일을 다르게 읽을 수 있다.
 */
export function textProblem(text: string): string | null {
  if (text.startsWith('\ufeff')) return '파일 맨 앞에 BOM(U+FEFF)이 있습니다.';
  let line = 1;
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n === 0x0a) { line++; continue; }
    const ok = n === 0x09 || (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd && n !== 0xfeff) || n >= 0x10000;
    if (!ok) return `${String(line)}번째 줄에 쓸 수 없는 문자 U+${n.toString(16).toUpperCase().padStart(4, '0')}가 있습니다(제어 문자·BOM·비문자·CR).`;
  }
  return null;
}

const firstError = (errors: readonly { message: string }[]) => (errors[0]?.message ?? '').split('\n')[0] ?? '';

/**
 * Claude: `---` 사이 frontmatter + 본문. frontmatter는 YAML 1.2 엄격 분석으로 읽는다.
 * - 문서는 정확히 하나, 오류·경고 0건.
 * - 앵커·별칭·태그를 쓰지 않는다. 값이 다른 곳에서 오거나 타입이 바뀌기 때문이다.
 *   병합 키(<<)는 merge:false로 일반 키가 되어, 값이 문자열이 아니면 형식 오류, 문자열이면 허용하지 않은 키로 잡힌다.
 * - 최상위는 문자열 키의 mapping, 값은 모두 문자열 하나.
 * - YAML 1.1로 읽어도 같은 결과여야 한다. Claude Code가 쓰는 YAML 분석기의 버전을 확인하지 못했으므로
 *   두 버전이 다르게 읽는 값(예: yes·on·1:2)은 받지 않는다.
 */
function parseClaude(text: string): Parsed | string {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return '파일이 `---` frontmatter로 시작하지 않습니다.';
  const source = m[1] ?? '';
  // 주석 금지(owner 결정): 「지시문 보기」 화면의 원문과 CLI가 받는 값이 같아야 한다. yaml 패키지의 lexer가 주석으로 나눈 토큰을 찾는다.
  const comment = [...new Lexer().lex(source)].find((token) => token.startsWith('#'));
  if (comment !== undefined) return `frontmatter에 YAML 주석(${comment.slice(0, 20)})을 쓰지 않습니다. 화면의 원문과 CLI가 받는 값이 달라집니다.`;
  let result: Record<string, string> | null = null;
  for (const version of ['1.2', '1.1'] as const) {
    const docs = parseAllDocuments(source, { version, strict: true, uniqueKeys: true, prettyErrors: false, merge: false });
    const list = Array.isArray(docs) ? docs : [docs];
    if (list.length !== 1) return `frontmatter에는 YAML 문서가 하나만 있어야 합니다(${String(list.length)}개).`;
    const doc = list[0];
    if (!doc) return 'frontmatter가 비었습니다.';
    if (doc.errors.length) return `frontmatter YAML 오류(${version}): ${firstError(doc.errors)}`;
    if (doc.warnings.length) return `frontmatter YAML 경고(${version}, 오류로 봄): ${firstError(doc.warnings)}`;
    let special: string | null = null;
    visit(doc, {
      Node(_, node) {
        // 별칭은 앵커가 있어야 쓸 수 있으므로 둘을 함께 막는다.
        if (isAlias(node) || node.anchor) { special = '앵커(&)·별칭(*)'; return visit.BREAK; }
        if (node.tag) { special = `태그(${node.tag})`; return visit.BREAK; }
        return undefined;
      },
    });
    if (special) return `frontmatter에 ${special}를 쓰지 않습니다.`;
    if (!isMap(doc.contents)) return 'frontmatter 최상위는 `키: 값` 목록이어야 합니다.';
    const out: Record<string, string> = {};
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') return 'frontmatter 키는 문자열이어야 합니다.';
      const key = pair.key.value;
      // `tools:`처럼 값을 비운 줄은 빈 값으로 본다(뒤의 tools·name 규칙이 잡는다). `~`·`null`처럼 적은 null은 문자열이 아니다.
      const empty = pair.value === null || (isScalar(pair.value) && pair.value.value === null && pair.value.source === '');
      if (empty) { out[key] = ''; continue; }
      if (!isScalar(pair.value) || typeof pair.value.value !== 'string') return `frontmatter ${key} 값은 문자열 하나여야 합니다.`;
      out[key] = pair.value.value;
    }
    if (result && JSON.stringify(result) !== JSON.stringify(out)) return 'frontmatter를 YAML 1.1과 1.2가 다르게 읽습니다.';
    result = out;
  }
  if (!result) return 'frontmatter를 읽지 못했습니다.';
  const parsed: Parsed = { keys: Object.keys(result), instructions: m[2] ?? '', visible: [...Object.values(result), m[2] ?? ''] };
  if ('name' in result) parsed.name = result.name?.trim();
  if ('description' in result) parsed.description = result.description?.trim();
  if ('tools' in result) parsed.tools = (result.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return parsed;
}

/**
 * TOML 주석이 있는지 표준 분석기만으로 판단한다(손으로 만든 문자열 경계 해석을 쓰지 않는다).
 * 방법: 원문의 모든 `#`을 파일에 없는 글자로 바꿔 다시 분석한다.
 *   - `#`가 모두 문자열 안에 있으면 분석이 성공하고, 그 글자를 `#`로 되돌린 결과가 원래 결과와 같다.
 *   - 하나라도 주석을 여는 `#`이면 분석이 실패하거나(값 뒤에 맨 글자) 결과가 달라진다(`#model = …` → 새 키).
 */
const COMMENT_PROBE = '\u{F0000}';
function tomlHasComment(text: string, table: Record<string, unknown>): boolean {
  if (!text.includes('#')) return false;
  if (text.includes(COMMENT_PROBE)) return true; // 확인할 수 없으면 주석이 있는 것으로 본다(fail-closed).
  try {
    const probed = JSON.stringify(parseToml(text.replaceAll('#', COMMENT_PROBE))).replaceAll(COMMENT_PROBE, '#');
    return probed !== JSON.stringify(table);
  } catch {
    return true;
  }
}

/** Codex: 표준 TOML 분석(smol-toml, TOML 1.1.0). 허용한 키의 값은 문자열이어야 한다(표·배열·숫자는 받지 않는다). */
function parseCodex(text: string): Parsed | string {
  let table: Record<string, unknown>;
  try {
    table = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    return `TOML 오류: ${(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''}`;
  }
  if (tomlHasComment(text, table)) return 'TOML 주석(#)을 쓰지 않습니다. 화면의 원문과 CLI가 받는 값이 달라집니다.';
  const out: Parsed = { keys: Object.keys(table), instructions: '', visible: Object.values(table).flatMap(stringLeaves) };
  for (const [key, value] of Object.entries(table)) {
    // 허용하지 않은 키는 config-key 규칙이 이름으로 잡는다. 허용한 키의 값만 여기서 문자열인지 본다.
    if (typeof value !== 'string') {
      if (CODEX_KEYS.has(key)) return `TOML ${key} 값은 문자열이어야 합니다(표·배열·숫자 불가).`;
      continue;
    }
    if (key === 'name') out.name = value.trim();
    if (key === 'description') out.description = value.trim();
    if (key === 'developer_instructions') out.instructions = value;
  }
  return out;
}

/* ───────────── 규칙 ───────────── */

const KEY = /^[a-z][a-z0-9-]{1,62}$/;
const CLAUDE_KEYS = new Set(['name', 'description', 'tools']);
/**
 * Codex 역할 파일에서 쓰는 키. `sandbox_mode`는 넣지 않는다.
 * Codex는 역할 파일의 sandbox_mode를 적용하지 않고 부모 세션의 권한(sandbox·승인 정책)을 그대로 물려준다(리뷰 P2-1).
 * 적어 두면 권한을 보장하는 것처럼 보이므로 거부한다. 근거: openai/codex `core/src/agent/role.rs`의 AgentRoleOverrides,
 * `child_config.rs`의 apply_spawn_agent_runtime_overrides, 시험 apply_role_preserves_parent_sandbox_permissions.
 */
const CODEX_KEYS = new Set(['name', 'description', 'developer_instructions']);
const MODEL_KEYS = new Set(['model', 'effort', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'model_provider', 'reasoning_effort']);
const MODEL_TEXT = /claude-(haiku|sonnet|opus|fable)|\bgpt-\d|\bo\d-(mini|pro)\b|model_reasoning_effort|\beffort\s*[:=]/i;
/** Claude 도구 허용 목록. 하위 Agent를 더 띄우는 Agent·Task, 외부 접속 WebFetch·WebSearch, MCP 도구는 뺀다. */
const CLAUDE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
const CLAUDE_WRITE = new Set(['Edit', 'Write', 'Bash']);
/** Codex 도구 표기. 역할 파일로 도구를 고를 수 없어 부모 세션의 shell·apply_patch를 그대로 물려받는다. 표시도 둘 다 적는다. */
const CODEX_TOOLS = ['shell', 'apply_patch'];
/** Codex 권한 표시의 앞부분. 그 뒤에는 지시문으로 둔 제한만 「· …(지시문)」으로 덧붙인다. */
export const CODEX_SANDBOX_LABEL = '부모 세션 권한 상속';

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
    // 파일 자체 검사(UTF-8·문자) → 표준 분석기 순서다. 앞 단계가 실패하면 분석 결과를 믿지 않는다.
    const fileProblem = d.encodingError ?? textProblem(d.text);
    if (fileProblem) { add(k, 'format', fileProblem); continue; }
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
    // 정책 검사 대상: CLI가 보게 될 해석된 문자열 전부.
    const visible = parsed.visible.join('\n');
    if (MODEL_TEXT.test(visible)) add(k, 'model-effort', '지시문·설정 값에 모델 이름이나 effort를 적었습니다.');

    // 도구·권한
    if (d.agent === 'Claude') {
      // tools를 생략하면 Claude는 부모의 도구를 물려준다. 빈 목록과 같게 보면 안 된다(리뷰 P2-2).
      if (parsed.tools === undefined || parsed.tools.length === 0) add(k, 'tools', 'Claude 정의에는 비어 있지 않은 tools 줄이 있어야 합니다. 생략하면 부모 세션의 도구를 모두 물려받습니다.');
      const fileTools = parsed.tools ?? [];
      if (fileTools.join(',') !== d.tools.join(',')) add(k, 'tools', `파일의 tools(${fileTools.join(', ')})와 manifest tools(${d.tools.join(', ')})가 다릅니다.`);
      for (const t of new Set([...fileTools, ...d.tools])) if (!CLAUDE_TOOLS.has(t)) add(k, 'tools', `허용하지 않은 도구입니다: ${t}`);
      const writes = fileTools.some((t) => CLAUDE_WRITE.has(t));
      if (writes !== d.sandbox.startsWith('worktree 쓰기')) add(k, 'tools', `권한 표시(${d.sandbox})가 도구와 맞지 않습니다. 쓰기·명령 도구가 있으면 「worktree 쓰기」, 없으면 「읽기 전용」입니다.`);
      if (!writes && d.sandbox !== '읽기 전용') add(k, 'tools', '읽기 전용 정의의 권한 표시는 「읽기 전용」입니다.');
    } else {
      // 역할 파일은 권한을 줄이지도 넓히지도 못한다. 표시가 그 사실을 말해야 한다(리뷰 P2-1).
      if (!d.sandbox.startsWith(CODEX_SANDBOX_LABEL) || /읽기 전용|worktree 쓰기/.test(d.sandbox)) add(k, 'tools', `Codex 권한 표시는 「${CODEX_SANDBOX_LABEL}」로 시작하고 읽기 전용·쓰기 권한을 약속하지 않습니다(${d.sandbox}).`);
      if (d.tools.join(',') !== CODEX_TOOLS.join(',')) add(k, 'tools', `Codex 도구 표시는 물려받는 ${CODEX_TOOLS.join(', ')}입니다(${d.tools.join(', ')}).`);
    }

    // Mock과 충돌 지시
    if (mockIds.has(k)) add(k, 'mock-text', `Mock 정의 이름(${k})을 그대로 썼습니다. demo 정의와 섞이지 않게 다른 이름을 씁니다.`);
    const body = norm(visible);
    for (const s of sentences) if (body.includes(s)) { add(k, 'mock-text', `SUB_MOCK 문장을 그대로 옮겼습니다: ${s.slice(0, 30)}…`); break; }
    for (const c of CONFLICT_PATTERNS) {
      const hit = c.pattern.exec(visible);
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
