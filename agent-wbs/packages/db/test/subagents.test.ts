import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkSubagentSet,
  loadMockSubagents,
  loadSubagentSet,
  type SubagentRule,
  type SubagentSet,
} from '../src/subagents.ts';

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`없음: ${what}`);
  return value;
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const set = await loadSubagentSet();
const mock = await loadMockSubagents();

/** 한 정의만 바꾼 복사본을 만든다. 바꾼 뒤 hash를 다시 계산할지 고를 수 있다(hash 규칙과 다른 규칙을 따로 시험하려고). */
function mutate(key: string, change: (d: SubagentSet['defs'][number]) => void, rehash = true): SubagentSet {
  const copy: SubagentSet = structuredClone(set);
  const def = copy.defs.find((d) => d.key === key);
  if (!def) throw new Error(`no def ${key}`);
  change(def);
  if (rehash) {
    const old = def.hash;
    def.hash = sha(def.text);
    copy.review = copy.review.replaceAll(old, def.hash);
  }
  return copy;
}

const rules = (s: SubagentSet) => new Set(checkSubagentSet(s, mock).map((i) => i.rule));
function expectRule(s: SubagentSet, rule: SubagentRule) {
  const found = checkSubagentSet(s, mock);
  expect(found.map((i) => i.rule), JSON.stringify(found)).toContain(rule);
}

const claude = () => must(set.defs.find((d) => d.agent === 'Claude' && d.sandbox.startsWith('worktree')), 'value');
const claudeRead = () => must(set.defs.find((d) => d.agent === 'Claude' && d.sandbox === '읽기 전용'), 'value');
const codex = () => must(set.defs.find((d) => d.agent === 'Codex'), 'value');

describe('실제 하위 Agent v1 정의(M5-06)', () => {
  it('저장소의 정의 묶음은 모든 검사를 통과한다', () => {
    expect(checkSubagentSet(set, mock)).toEqual([]);
  });

  it('10개 안팎이고 Claude·Codex 정의가 모두 있으며 전부 v1이다', () => {
    expect(set.defs.length).toBeGreaterThanOrEqual(8);
    expect(set.defs.length).toBeLessThanOrEqual(12);
    expect(new Set(set.defs.map((d) => d.agent))).toEqual(new Set(['Claude', 'Codex']));
    expect(set.defs.every((d) => d.version === 1)).toBe(true);
    expect(set.defs.every((d) => /^[a-f0-9]{64}$/.test(d.hash))).toBe(true);
  });

  it('원본 Mock 정의(SUB_MOCK)를 읽어 왔다 — 비교 대상이 비면 검사가 의미 없다', () => {
    expect(mock.length).toBe(10);
    expect(mock.every((m) => m.text.length > 20)).toBe(true);
  });

  it('hash: 파일 내용과 다르면 잡는다', () => {
    expectRule(mutate(claude().key, (d) => { d.text += '\n'; }, false), 'hash');
  });

  it('version: 0·소수·파일 이름과 다른 버전·중복을 잡는다', () => {
    for (const v of [0, 1.5]) {
      // 파일 이름도 같은 버전으로 맞춰, 파일 이름 검사가 아니라 정수 검사가 잡는지 본다.
      const s = mutate(claude().key, (d) => { d.version = v; d.file = d.file.replace('.v1.', `.v${String(v)}.`); });
      expect(checkSubagentSet(s, mock).filter((i) => i.rule === 'version').map((i) => i.message)).toEqual(['버전은 1 이상의 정수입니다.']);
    }
    expectRule(mutate(claude().key, (d) => { d.version = 2; }), 'version');
    const dup: SubagentSet = structuredClone(set);
    dup.defs.push(structuredClone(must(dup.defs[0], 'value')));
    expectRule(dup, 'version');
  });

  it('review: 검토 기록에 정의·버전·hash가 없으면 잡는다(내용을 바꾸고 다시 검토하지 않은 경우)', () => {
    const s = mutate(claude().key, (d) => { d.text = d.text.replace('맡은 일', '맡은  일'); }, false);
    const def = must(s.defs.find((d) => d.key === claude().key), 'value');
    def.hash = sha(def.text); // manifest hash만 고치고 REVIEW.md는 그대로
    expect(rules(s).has('hash')).toBe(false);
    expectRule(s, 'review');
  });

  it('model-effort: Claude frontmatter의 model·effort를 잡는다', () => {
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace('\ntools:', '\nmodel: opus\ntools:'); }), 'model-effort');
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace('\ntools:', '\neffort: high\ntools:'); }), 'model-effort');
  });

  it('model-effort: Codex TOML의 model·model_reasoning_effort를 잡는다', () => {
    expectRule(mutate(codex().key, (d) => { d.text = `model = "gpt-6.1-sol"\n${d.text}`; }), 'model-effort');
    expectRule(mutate(codex().key, (d) => { d.text = `model_reasoning_effort = "high"\n${d.text}`; }), 'model-effort');
  });

  it('model-effort: 지시문 본문에 모델 이름을 적어도 잡는다', () => {
    expectRule(mutate(claude().key, (d) => { d.text += '\n- claude-opus-5-5로 실행한다.\n'; }), 'model-effort');
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replace('맡은 일', 'gpt-6.2-sol로 맡은 일'); }), 'model-effort');
  });

  it('config-key: hook·권한 우회·외부 서버 설정 같은 허용되지 않은 키를 잡는다', () => {
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace('\ntools:', '\npermissionMode: bypassPermissions\ntools:'); }), 'config-key');
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace('\ntools:', '\nhooks: x\ntools:'); }), 'config-key');
    expectRule(mutate(codex().key, (d) => { d.text = `approval_policy = "never"\n${d.text}`; }), 'config-key');
    expectRule(mutate(codex().key, (d) => { d.text = `${d.text}\n[mcp_servers.x]\ncommand = "x"\n`; }), 'config-key');
    // Codex 역할 파일의 sandbox_mode는 적용되지 않는다(부모 권한 상속). 적으면 권한을 보장하는 것처럼 보이므로 거부한다(리뷰 P2-1).
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access'])
      expectRule(mutate(codex().key, (d) => { d.text = d.text.replace('developer_instructions = """', `sandbox_mode = "${mode}"\ndeveloper_instructions = """`); }), 'config-key');
  });

  it('name: 설치 파일 이름(def_key)으로 안전하지 않은 키를 잡는다', () => {
    // Runner는 def_key로 `.claude/agents/<def_key>.md`·`.codex/agents/<def_key>.toml`을 만든다(M5-02와 맞춘 규칙).
    for (const bad of ['../escape', 'a/b', 'Upper', 'x', 'with space', 'dot.name']) {
      const s = mutate(claude().key, (d) => {
        d.text = d.text.replace(`name: ${d.key}`, `name: ${bad}`);
        d.file = d.file.replace(d.key, bad);
        d.key = bad;
      });
      expect(checkSubagentSet(s, mock).some((i) => i.rule === 'name' && i.message.includes('정의 이름은')), bad).toBe(true);
    }
  });

  it('name: 파일 안 이름이 정의 이름과 다르거나 설명이 비면 잡는다', () => {
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace(`name: ${d.key}`, 'name: other-agent'); }), 'name');
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replace(/^description = ".*"$/m, 'description = ""'); }), 'name');
  });

  it('tools: 허용 목록 밖 도구·파일과 다른 도구·읽기 전용인데 쓰기 도구를 잡는다', () => {
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace(/^tools: (.*)$/m, 'tools: $1, WebFetch'); d.tools.push('WebFetch'); }), 'tools');
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace(/^tools: (.*)$/m, 'tools: $1, Agent'); d.tools.push('Agent'); }), 'tools');
    expectRule(mutate(claude().key, (d) => { d.tools = d.tools.filter((t) => t !== 'Grep'); }), 'tools');
    expectRule(mutate(claudeRead().key, (d) => { d.text = d.text.replace(/^tools: (.*)$/m, 'tools: $1, Edit'); d.tools.push('Edit'); }), 'tools');
    // Claude: tools를 생략하면 부모 도구를 상속한다. 빈 목록과 같게 보면 안 된다(리뷰 P2-2).
    {
      const s = mutate(claudeRead().key, (d) => { d.text = d.text.replace(/^tools: .*\n/m, ''); d.tools = []; });
      expect(rules(s).has('format'), JSON.stringify(checkSubagentSet(s, mock))).toBe(false);
      expectRule(s, 'tools');
    }
    expectRule(mutate(claudeRead().key, (d) => { d.text = d.text.replace(/^tools: .*$/m, 'tools:'); d.tools = []; }), 'tools');
    // Codex: 역할 파일로 도구·권한을 줄일 수 없다. 표시는 「부모 세션 권한 상속」이어야 하고 「읽기 전용」을 약속하면 안 된다(리뷰 P2-1).
    expectRule(mutate(codex().key, (d) => { d.sandbox = '읽기 전용'; }), 'tools');
    expectRule(mutate(codex().key, (d) => { d.sandbox = 'worktree 쓰기'; }), 'tools');
    expectRule(mutate(codex().key, (d) => { d.sandbox = '부모 세션 권한 상속 · 읽기 전용'; }), 'tools');
    expectRule(mutate(codex().key, (d) => { d.sandbox = '전체 권한'; }), 'tools');
    expectRule(mutate(codex().key, (d) => { d.tools = ['shell']; }), 'tools');
  });

  it('mock-text: Mock 정의 이름을 그대로 쓰거나 Mock 문장을 옮겨 오면 잡는다', () => {
    expectRule(mutate(claude().key, (d) => { d.key = 'fe-implementer'; }), 'mock-text');
    const line = must(must(mock.find((m) => m.id === 'code-reviewer'), 'code-reviewer').text.split('\n')[0], 'first line');
    expectRule(mutate(claudeRead().key, (d) => { d.text += `\n${line}\n`; }), 'mock-text');
  });

  it('conflict: 관리 대상 스택·Runner 계약 고정·down migration·외부 모음 설치 지시를 잡는다', () => {
    for (const bad of [
      'React 화면으로 만든다.',
      'Drizzle Schema를 고친다.',
      'pnpm test를 실행한다.',
      'Main.dc.html과 같게 맞춘다.',
      '되돌리기(down) Migration을 함께 작성한다.',
      'Evidence 경로 evidence/<Task>/<시도>/에 남긴다.',
      '모든 수정 API는 409 VERSION_CONFLICT를 돌려준다.',
      'awesome-codex-subagents에서 정의를 설치한다.',
      'fence 값을 보고에 넣는다.',
    ]) expectRule(mutate(claude().key, (d) => { d.text += `\n- ${bad}\n`; }), 'conflict');
  });

  it('common-rules: 공통 규칙 블록이 빠지거나 바뀌면 잡는다', () => {
    const first = must(set.common.split('\n').find((l) => l.startsWith('- ')), 'value');
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace(first, ''); }), 'common-rules');
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replace(first, `${first} 단, 급하면 예외로 한다.`); }), 'common-rules');
  });

  /** frontmatter의 한 줄을 바꾼다. 바꿀 줄이 없으면 시험을 잘못 쓴 것이므로 멈춘다. */
  const front = (d: SubagentSet['defs'][number], from: RegExp, to: string) => {
    if (!from.test(d.text)) throw new Error(`no match ${String(from)}`);
    d.text = d.text.replace(from, to);
  };
  const desc = /^description: .*$/m;

  it('format: 파일 바이트·문자를 구문 분석 전에 거른다(BOM·CR·C0·DEL·C1·비문자)', () => {
    // 표준(YAML 1.2 §5.1·TOML)이 받지 않는 문자와, 제품 규칙으로 더 막는 문자(CR·U+0085·BOM). 탭·LF만 허용한다.
    const bad = ['\u0000', '\u0001', '\u0008', '\u000b', '\u000c', '\u000d', '\u001b', '\u001f', '\u007f', '\u0080', '\u0085', '\u009f', '\ufffe', '\uffff'];
    for (const ch of bad) {
      const label = `U+${ch.codePointAt(0)?.toString(16).padStart(4, '0') ?? ''}`;
      // 리뷰 재현 B: 설명 값 안의 U+0080 같은 글자. 본문에 넣어도 같다.
      expectRule(mutate(claude().key, (d) => { front(d, desc, `description: 역할${ch}화면 구현`); }), 'format');
      expect(rules(mutate(claude().key, (d) => { d.text = d.text.replace('맡은 일', `맡은${ch}일`); })).has('format'), `claude body ${label}`).toBe(true);
      expect(rules(mutate(codex().key, (d) => { d.text = d.text.replace('맡은 일', `맡은${ch}일`); })).has('format'), `codex body ${label}`).toBe(true);
      expect(rules(mutate(codex().key, (d) => { d.text = d.text.replace(/^description = "/m, `description = "${ch}`); })).has('format'), `codex value ${label}`).toBe(true);
    }
    // BOM(U+FEFF)이 맨 앞에 있으면 거부한다. CLI마다 BOM 처리가 달라 같은 파일을 다르게 읽을 수 있다.
    expectRule(mutate(claude().key, (d) => { d.text = `\ufeff${d.text}`; }), 'format');
    expectRule(mutate(codex().key, (d) => { d.text = `\ufeff${d.text}`; }), 'format');
    // 줄 끝은 LF만 쓴다(hash가 줄 끝 방식에 따라 달라지지 않게).
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replaceAll('\n', '\r\n'); }), 'format');
  });

  it('format: UTF-8로 읽을 수 없는 파일은 로드 단계에서 format으로 잡는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awbs-subagents-'));
    try {
      await cp(fileURLToPath(new URL('../seed/subagents/', import.meta.url)), dir, { recursive: true });
      const target = claude().file;
      const bytes = await readFile(join(dir, target));
      // 0xC3 0x28: 잘못된 2바이트 순서. 0xFF: UTF-8에 나올 수 없는 바이트.
      for (const junk of [[0xc3, 0x28], [0xff], [0xed, 0xa0, 0x80]]) {
        await writeFile(join(dir, target), Buffer.concat([bytes, Buffer.from(junk)]));
        const loaded = await loadSubagentSet(pathToFileURL(`${dir}/`));
        const found = checkSubagentSet(loaded, mock).filter((i) => i.key === claude().key);
        expect(found.map((i) => i.rule), JSON.stringify(junk)).toContain('format');
        expect(found.find((i) => i.rule === 'format')?.message).toContain('UTF-8');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('format: Claude frontmatter는 YAML 1.2 엄격 분석(경고도 오류)으로 읽는다', () => {
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace(/^---\n/, ''); }), 'format');
    const cases: [string, (d: SubagentSet['defs'][number]) => void][] = [
      // 리뷰 이전 재현과 재현 A: 따옴표 없는 값 안의 「: 」·「:<탭>」.
      ['colon-space', (d) => { front(d, desc, 'description: 역할: 화면 구현'); }],
      ['colon-tab', (d) => { front(d, desc, 'description: 역할:\t화면 구현'); }],
      ['colon-end', (d) => { front(d, desc, 'description: 끝이 콜론:'); }],
      // 탭 들여쓰기: YAML은 들여쓰기에 탭을 쓸 수 없다.
      ['tab-indent', (d) => { front(d, desc, 'description:\n\t화면 구현'); }],
      ['tab-before-key', (d) => { front(d, desc, '\tdescription: 화면 구현'); }],
      // 중복 키: 뒤의 값이 앞의 값을 몰래 덮는다.
      ['dup-key', (d) => { front(d, desc, 'description: 화면 구현\ndescription: 다른 설명'); }],
      ['dup-name', (d) => { front(d, /^name: .*$/m, `name: ${d.key}\nname: ${d.key}`); }],
      // 앵커·별칭·태그: 값이 다른 곳에서 오거나 타입이 바뀐다. 정의 파일에는 쓰지 않는다.
      ['anchor', (d) => { front(d, desc, 'description: &d 화면 구현'); }],
      ['alias', (d) => { front(d, /^name: (.*)$/m, 'name: &n $1'); front(d, desc, 'description: *n'); }],
      ['undefined-alias', (d) => { front(d, desc, 'description: *없음'); }],
      ['tag', (d) => { front(d, desc, 'description: !!str 화면 구현'); }],
      ['local-tag', (d) => { front(d, desc, 'description: !태그 화면'); }],
      ['merge-key', (d) => { front(d, desc, 'description: 화면 구현\n<<: {extra: x}'); }],
      // 다중 문서: 문서 끝(...)·시작(--- 뒤 내용) 표시로 두 번째 문서를 숨긴다.
      ['doc-end', (d) => { front(d, desc, 'description: 화면 구현\n...\nmodel: hidden'); }],
      ['directive', (d) => { d.text = d.text.replace(/^---\n/, '---\n%YAML 1.2\n'); }],
      // strict 모드에서만 오류: 1024자를 넘는 암묵 키(YAML 1.2 규칙).
      ['long-key', (d) => { front(d, desc, `description: 화면 구현\n${'k'.repeat(1100)}: x`); }],
      // 문자열이 아닌 값·여러 줄 구조.
      ['flow-seq', (d) => { front(d, desc, 'description: [화면, 구현]'); }],
      ['flow-map', (d) => { front(d, desc, 'description: {a: b}'); }],
      ['block-seq', (d) => { front(d, /^tools: .*$/m, 'tools:\n  - Read\n  - Glob\n  - Grep'); d.tools = ['Read', 'Glob', 'Grep']; }],
      ['number', (d) => { front(d, desc, 'description: 0x1f'); }],
      // YAML 1.1과 1.2가 다르게 읽는 값: 어느 분석기로 읽어도 같은 문자열이어야 한다.
      ['yaml11-bool', (d) => { front(d, desc, 'description: yes'); }],
      ['yaml11-sexagesimal', (d) => { front(d, desc, 'description: 1:2'); }],
      ['null', (d) => { front(d, desc, 'description: ~'); }],
      // 따옴표·블록 표시가 깨진 값.
      ['open-quote', (d) => { front(d, desc, 'description: "따옴표'); }],
      ['open-single', (d) => { front(d, desc, "description: '작은따옴표"); }],
      ['seq-in-value', (d) => { front(d, desc, 'description: - 목록'); }],
      ['open-bracket', (d) => { front(d, desc, 'description: [대괄호'); }],
      ['block-bad', (d) => { front(d, desc, 'description: |블록'); }],
      ['reserved-at', (d) => { front(d, desc, 'description: @예약'); }],
      ['reserved-backtick', (d) => { front(d, desc, 'description: `예약'); }],
      ['percent', (d) => { front(d, desc, 'description: %지시'); }],
    ];
    for (const [name, change] of cases) {
      const s = mutate(claude().key, change);
      expect(rules(s).has('format'), `${name}: ${JSON.stringify(checkSubagentSet(s, mock))}`).toBe(true);
    }
  });

  it('format: YAML 경고도 오류로 본다', () => {
    // 해석할 수 없는 태그(!foo)는 yaml 패키지가 오류가 아니라 경고(TAG_RESOLVE_FAILED)로만 알린다.
    const s = mutate(claude().key, (d) => { front(d, desc, 'description: !foo 화면 구현'); });
    const found = checkSubagentSet(s, mock).filter((i) => i.rule === 'format');
    expect(found.map((i) => i.message).join(' '), JSON.stringify(found)).toContain('경고');
  });

  it('format: 표준 YAML이 받는 따옴표 값은 통과한다(검사기가 CLI보다 엄격하기만 하고 다르게 읽지 않는다)', () => {
    const s = mutate(claude().key, (d) => { front(d, desc, `description: "${must(/^description: (.*)$/m.exec(d.text), 'desc')[1] ?? ''}"`); });
    expect(checkSubagentSet(s, mock)).toEqual([]);
  });

  it('format: Codex 파일은 표준 TOML 분석기(smol-toml, TOML 1.1.0)로 읽는다', () => {
    const cases: [string, (d: SubagentSet['defs'][number]) => void][] = [
      // 리뷰 이전 재현: 여러 줄 문자열 본문 안의 """.
      ['triple-quote-line', (d) => { d.text = d.text.replace('맡은 일', '맡은 일\n- 출력 예: """hello"""'); }],
      ['triple-quote-inline', (d) => { d.text = d.text.replace('맡은 일', '맡은 일 """ 끝'); }],
      ['bad-escape', (d) => { d.text = d.text.replace('맡은 일', '맡은 \\q일'); }],
      ['bad-unicode-escape', (d) => { d.text = d.text.replace('맡은 일', '맡은 \\uD800일'); }],
      ['dup-key', (d) => { d.text = `${d.text}name = "${d.key}"\n`; }],
      ['dup-instructions', (d) => { d.text = `${d.text}developer_instructions = "x"\n`; }],
      ['unterminated', (d) => { d.text = d.text.replace(/"""\n$/, ''); }],
      ['open-string', (d) => { d.text = d.text.replace(/^description = "(.*)"$/m, 'description = "$1'); }],
      ['bare-value', (d) => { d.text = d.text.replace(/^description = "(.*)"$/m, 'description = $1'); }],
      ['number-name', (d) => { d.text = d.text.replace(/^name = ".*"$/m, 'name = 1'); }],
      ['array-value', (d) => { d.text = d.text.replace(/^description = "(.*)"$/m, 'description = ["$1"]'); }],
      ['table', (d) => { d.text = `${d.text}\n[extra]\nx = "y"\n`; }],
      ['inline-table', (d) => { d.text = `extra = { x = "y" }\n${d.text}`; }],
      ['dotted-key', (d) => { d.text = `features.shell_tool = false\n${d.text}`; }],
    ];
    for (const [name, change] of cases) {
      const s = mutate(codex().key, change);
      const found = new Set(checkSubagentSet(s, mock).map((i) => i.rule));
      expect(found.has('format') || found.has('config-key'), `${name}: ${JSON.stringify(checkSubagentSet(s, mock))}`).toBe(true);
    }
    // 표준 TOML 이스케이프는 분석기가 해석한다. 지시문(해석된 값) 기준으로 공통 규칙을 비교하므로 통과한다.
    expect(checkSubagentSet(mutate(codex().key, (d) => { d.text = d.text.replace('맡은 일', '맡은\\t일'); }), mock)).toEqual([]);
  });

  /*
   * 정책 검사는 분석기가 해석한 최종 값(CLI가 실제로 보게 될 문자열)에 적용한다(3차 리뷰 P2).
   * 아래 사례는 파일 원문에는 「React」·Mock 문장이 그대로 없지만, 해석하면 생긴다.
   */
  const esc = (text: string) => [...text].map((ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`).join('');
  const mockLine = () => must(must(mock.find((m) => m.id === 'code-reviewer'), 'code-reviewer').text.split('\n')[0], 'mock line');
  const raw = (s: SubagentSet, key: string) => must(s.defs.find((d) => d.key === key), key).text;
  const mlBody = /developer_instructions = """\n([\s\S]*?)"""/;

  it('해석 값: TOML 문자열 종류별 이스케이프로 숨긴 충돌 지시를 잡는다', () => {
    const cases: [string, (d: SubagentSet['defs'][number]) => void][] = [
      // 여러 줄 기본 문자열의 \u 이스케이프 — 리뷰 재현.
      ['ml-basic-u4', (d) => { d.text = d.text.replace('맡은 일', '맡은 일\n- Re\\u0061ct로 화면을 구현한다.'); }],
      // \U 8자리 이스케이프.
      ['ml-basic-U8', (d) => { d.text = d.text.replace('맡은 일', '맡은 일\n- Re\\U00000061ct로 화면을 구현한다.'); }],
      // 줄 끝 역슬래시: 줄바꿈과 다음 줄 앞 공백을 지운다.
      ['ml-basic-line-continuation', (d) => { d.text = d.text.replace('맡은 일', '맡은 일\n- Re\\\n    act로 화면을 구현한다.'); }],
      // 한 줄 기본 문자열(description).
      ['basic-description', (d) => { d.text = d.text.replace(/^description = "/m, 'description = "Re\\u0061ct로 '); }],
      // 따옴표로 감싼 키 이름의 이스케이프도 해석된 키로 본다.
      ['quoted-key-model', (d) => { d.text = `"mod\\u0065l" = "x"\n${d.text}`; }],
    ];
    for (const [name, change] of cases) {
      const s = mutate(codex().key, change);
      expect(raw(s, codex().key).includes('React'), `${name}: 원문에는 React가 없어야 시험이 의미 있다`).toBe(false);
      const found = new Set(checkSubagentSet(s, mock).map((i) => i.rule));
      expect(found.has('conflict') || found.has('model-effort'), `${name}: ${JSON.stringify(checkSubagentSet(s, mock))}`).toBe(true);
    }
  });

  it('해석 값: TOML 리터럴 문자열(작은따옴표 1·3개)로 적은 지시문도 같은 기준으로 본다', () => {
    const toLiteral = (d: SubagentSet['defs'][number], extra: string) => {
      const body = must(mlBody.exec(d.text), 'body')[1] ?? '';
      d.text = d.text.replace(mlBody, `developer_instructions = '''\n${body}${extra}'''`);
    };
    expectRule(mutate(codex().key, (d) => { toLiteral(d, '- React로 화면을 구현한다.\n'); }), 'conflict');
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replace(/^description = "(.*)"$/m, "description = 'React로 $1'"); }), 'conflict');
    // 리터럴 문자열로 바꿔도 정상 지시문은 통과한다(공통 규칙은 해석 값으로 비교).
    expect(checkSubagentSet(mutate(codex().key, (d) => { toLiteral(d, ''); }), mock)).toEqual([]);
  });

  it('해석 값: 이스케이프로 숨긴 Mock 문장·모델 이름을 잡는다(TOML)', () => {
    const s = mutate(codex().key, (d) => { d.text = d.text.replace('맡은 일', `맡은 일\n${esc(mockLine())}`); });
    expect(raw(s, codex().key).includes(mockLine())).toBe(false);
    expectRule(s, 'mock-text');
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replace('맡은 일', '맡은 일\n- claude-\\u006fpus-5-5로 실행한다.'); }), 'model-effort');
  });

  it('해석 값: YAML 큰따옴표 이스케이프로 숨긴 충돌 지시·Mock 문장을 잡는다', () => {
    const cases: [string, string, SubagentRule][] = [
      ['u4', 'description: "Re\\u0061ct로 화면을 구현한다."', 'conflict'],
      ['x2', 'description: "Re\\x61ct로 화면을 구현한다."', 'conflict'],
      ['U8', 'description: "Re\\U00000061ct로 화면을 구현한다."', 'conflict'],
      // 큰따옴표 안 줄 끝 역슬래시: 줄바꿈을 지운다.
      ['line-continuation', 'description: "Re\\\n  act로 화면을 구현한다."', 'conflict'],
      ['model', 'description: "claude-\\u006fpus-5-5로 실행한다."', 'model-effort'],
    ];
    for (const [name, line, rule] of cases) {
      const s = mutate(claude().key, (d) => { front(d, desc, line); });
      expect(raw(s, claude().key).includes('React') || raw(s, claude().key).includes('claude-opus'), name).toBe(false);
      expect(checkSubagentSet(s, mock).map((i) => i.rule), `${name}: ${JSON.stringify(checkSubagentSet(s, mock))}`).toContain(rule);
    }
    expectRule(mutate(claude().key, (d) => { front(d, desc, `description: "${esc(mockLine())}"`); }), 'mock-text');
  });

  it('해석 값: YAML 작은따옴표·여러 줄 일반 값도 해석한 값으로 본다', () => {
    // 작은따옴표 안의 ''는 '로 해석된다. 접힌 여러 줄 값은 줄바꿈이 공백 한 칸이 된다.
    expectRule(mutate(claude().key, (d) => { front(d, desc, "description: 'React로 화면을 ''구현''한다.'"); }), 'conflict');
    expectRule(mutate(claude().key, (d) => { front(d, desc, 'description: 화면을\n  React로 구현한다.'); }), 'conflict');
  });

  it('해석 값: 이스케이프로 적은 도구 이름도 해석한 값으로 허용 목록과 비교한다', () => {
    const s = mutate(claudeRead().key, (d) => { front(d, /^tools: .*$/m, 'tools: "Read, Glob, Grep, Web\\u0046etch"'); d.tools.push('WebFetch'); });
    expect(raw(s, claudeRead().key).includes('WebFetch')).toBe(false);
    expectRule(s, 'tools');
  });
});
