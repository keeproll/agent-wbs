import { createHash } from 'node:crypto';
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

  it('format: Codex TOML이 허용한 모양(문자열 키와 """ 여러 줄 문자열)이 아니면 잡는다', () => {
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replace('맡은 일', '맡은 \\t일'); }), 'format');
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace(/^---\n/, ''); }), 'format');
  });

  it('format: 실제 YAML·TOML 구문 분석기가 거부할 값을 잡는다(리뷰 P2-3)', () => {
    // YAML: 따옴표 없는 값 안의 「: 」는 mapping values are not allowed here 오류다.
    expectRule(mutate(claude().key, (d) => { d.text = d.text.replace(/^description: .*$/m, 'description: 역할: 화면 구현'); }), 'format');
    for (const bad of ['"따옴표', "'작은따옴표", '- 목록', '[대괄호', '{중괄호', '&앵커', '*별표', '!태그', '|블록', '>접기', '%지시', '@예약', '`예약', '#주석', '값 #주석', '끝이 콜론:', '제어\u0001문자'])
      expectRule(mutate(claude().key, (d) => { d.text = d.text.replace(/^description: .*$/m, `description: ${bad}`); }), 'format');
    // TOML: 여러 줄 문자열 본문 안의 """는 문자열을 먼저 끝낸다.
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replace('맡은 일', '맡은 일\n- 출력 예: """hello"""'); }), 'format');
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replace('맡은 일', '맡은 일 """ 끝'); }), 'format');
    // TOML 기본 문자열은 탭 밖의 제어 문자를 받지 않는다.
    expectRule(mutate(codex().key, (d) => { d.text = d.text.replace('맡은 일', '맡은\u0001일'); }), 'format');
  });
});
