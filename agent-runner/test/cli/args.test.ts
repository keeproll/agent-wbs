import { describe, expect, test } from 'vitest';
import { buildLaunch, CliArgumentError, sessionOptions, type RunSpec } from '../../src/cli/args.ts';
import { IsolationUndecidedError, PENDING_ISOLATION, type IsolationLayer } from '../../src/cli/isolation.ts';

/** 시험용 격리 계층. Q-08 결정 뒤 실제 계층이 이 자리에 들어간다. */
const TEST_ISOLATION: IsolationLayer = {
  name: 'test',
  flags: (agent) => (agent === 'Codex' ? ['-c', 'sandbox_mode="workspace-write"'] : ['--permission-mode', 'acceptEdits']),
  wrap: (launch) => launch,
};
const spec: RunSpec = { model: 'gpt-6.2-sol', effort: 'high', cwd: '/work/wt', prompt: '지시문' };
const opts = { env: { PATH: '/usr/bin', HOME: '/h', AWBS_RUNNER_TOKEN: 'x' }, isolation: TEST_ISOLATION };

describe('buildLaunch — 실행 인자(argv, shell 문자열 조합 없음)', () => {
  test('Codex: exec --json, hook 끔, 모델·Effort, 지시문은 stdin(-)', () => {
    const l = buildLaunch('Codex', '/bin/codex', spec, opts);
    expect(l.file).toBe('/bin/codex');
    expect(l.args).toEqual([
      '-c', 'check_for_update_on_startup=false', 'exec', '--json', '--disable', 'hooks',
      '-c', 'sandbox_mode="workspace-write"', '--model', 'gpt-6.2-sol', '-c', 'model_reasoning_effort="high"', '-',
    ]);
    expect(l.stdin).toBe('지시문');
    expect(l.cwd).toBe('/work/wt');
    expect(l.args.join(' ')).not.toContain('지시문');
  });

  test('Codex 재개: exec resume <thread> 순서', () => {
    const l = buildLaunch('Codex', '/bin/codex', { ...spec, resume: '019a7c1e-3b2f-7d40' }, opts);
    expect(l.args.slice(2, 5)).toEqual(['exec', 'resume', '--json']);
    expect(l.args.slice(-2)).toEqual(['019a7c1e-3b2f-7d40', '-']);
  });

  test('Claude: -p stream-json --verbose, hook 끔(--settings), 모델·Effort, 지시문은 stdin', () => {
    const l = buildLaunch('Claude', '/bin/claude', { ...spec, model: 'claude-opus-5-5', effort: 'max' }, opts);
    expect(l.args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--settings', '{"disableAllHooks":true}',
      '--permission-mode', 'acceptEdits', '--model', 'claude-opus-5-5', '--effort', 'max',
    ]);
    expect(l.args).not.toContain('--include-hook-events');
    expect(l.stdin).toBe('지시문');
  });

  test('Claude 재개: --resume <session>', () => {
    const l = buildLaunch('Claude', '/bin/claude', { ...spec, model: 'claude-opus-5-5', resume: '0b6f3c2e-6a1d-4f7e' }, opts);
    expect(l.args.slice(-2)).toEqual(['--resume', '0b6f3c2e-6a1d-4f7e']);
  });

  test('환경 변수는 세션 allowlist를 쓴다', () => {
    expect(buildLaunch('Codex', '/bin/codex', spec, opts).env.AWBS_RUNNER_TOKEN).toBeUndefined();
  });
});

describe('buildLaunch — Effort(owner Q-06: low~max만, ultra·미확인 사용 안 함)', () => {
  test.each(['low', 'medium', 'high', 'xhigh', 'max'])('%s는 통과', (effort) => {
    expect(() => buildLaunch('Codex', '/bin/codex', { ...spec, effort }, opts)).not.toThrow();
  });

  test.each(['ultra', 'minimal', 'none', '', 'High', 'high"; rm -rf /'])('%j는 거부', (effort) => {
    expect(() => buildLaunch('Codex', '/bin/codex', { ...spec, effort }, opts)).toThrow(expect.objectContaining({ code: 'effort_unmapped' }));
  });

  test('모델이 보고한 값에 없는 단계는 거부(예: gpt-5.5의 max)', () => {
    expect(() => buildLaunch('Codex', '/bin/codex', { ...spec, model: 'gpt-5.5', effort: 'max', modelEfforts: ['low', 'medium', 'high', 'xhigh'] }, opts))
      .toThrow(expect.objectContaining({ code: 'effort_unsupported' }));
  });

  test('모델별 지원이 미확인(null)이면 쓰지 않는다', () => {
    expect(() => buildLaunch('Claude', '/bin/claude', { ...spec, model: 'claude-opus-5-5', modelEfforts: null }, opts))
      .toThrow(expect.objectContaining({ code: 'effort_unconfirmed' }));
  });
});

describe('buildLaunch — 입력값이 옵션으로 해석되지 않게 막는다', () => {
  test.each(['--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt 6', '', 'a\nb'])('모델 %j 거부', (model) => {
    expect(() => buildLaunch('Codex', '/bin/codex', { ...spec, model }, opts)).toThrow(CliArgumentError);
  });
  test.each(['--last', '-x', 'a b', '../x', ''])('재개 ID %j 거부', (resume) => {
    expect(() => buildLaunch('Claude', '/bin/claude', { ...spec, model: 'claude-opus-5-5', resume }, opts)).toThrow(CliArgumentError);
  });
  test('작업 폴더는 절대 경로, 지시문은 비어 있지 않아야 한다', () => {
    expect(() => buildLaunch('Codex', '/bin/codex', { ...spec, cwd: 'wt' }, opts)).toThrow(CliArgumentError);
    expect(() => buildLaunch('Codex', '/bin/codex', { ...spec, prompt: '' }, opts)).toThrow(CliArgumentError);
  });
});

describe('격리 계층 경계(Q-08 결정 대기)', () => {
  test('격리를 정하지 않으면 실행 계획을 만들지 않는다(fake 실행만)', () => {
    expect(() => buildLaunch('Codex', '/bin/codex', spec, { env: {} })).toThrow(IsolationUndecidedError);
    expect(() => buildLaunch('Codex', '/bin/codex', spec, { env: {}, isolation: PENDING_ISOLATION })).toThrow(IsolationUndecidedError);
  });

  test('격리 계층을 갈아끼우면 실행 파일·인자·환경을 감쌀 수 있다(예: 전용 사용자·컨테이너)', () => {
    const wrapped: IsolationLayer = {
      name: 'wrapper',
      flags: () => [],
      wrap: (l) => ({ ...l, file: '/usr/bin/runas', args: ['--', l.file, ...l.args], env: { ...l.env, WRAPPED: '1' } }),
    };
    const l = buildLaunch('Claude', '/bin/claude', { ...spec, model: 'claude-opus-5-5' }, { env: {}, isolation: wrapped });
    expect(l.file).toBe('/usr/bin/runas');
    expect(l.args.slice(0, 3)).toEqual(['--', '/bin/claude', '-p']);
    expect(l.env.WRAPPED).toBe('1');
  });
});

describe('sessionOptions — 관측 등급 조합의 「옵션」(readiness cli[]·cliGrades와 같은 값)', () => {
  test('모델·Effort·지시문·세션 ID 없이 실행 옵션만, 격리 옵션 포함', () => {
    expect(sessionOptions('Codex', TEST_ISOLATION, 'new')).toBe('exec --json --disable hooks -c sandbox_mode="workspace-write"');
    expect(sessionOptions('Claude', TEST_ISOLATION, 'new')).toBe('-p --output-format stream-json --verbose --settings {"disableAllHooks":true} --permission-mode acceptEdits');
  });

  test('buildLaunch 인자에 그대로 들어 있다(실행 조합과 보고 조합이 어긋나지 않음)', () => {
    for (const agent of ['Codex', 'Claude'] as const) {
      const l = buildLaunch(agent, '/bin/x', { ...spec, model: agent === 'Codex' ? 'gpt-6.2-sol' : 'claude-opus-5-5' }, opts);
      expect(l.args.join(' ')).toContain(sessionOptions(agent, TEST_ISOLATION, 'new'));
    }
  });
});
