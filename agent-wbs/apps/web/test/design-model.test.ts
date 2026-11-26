import { describe, expect, it } from 'vitest';
import {
  approvedDecisions, compatLabel, decisionGroups, decisionView, driftMark, driftView, fileRows, itemRows, kindCounts, layers, parseErrors,
  storeCounts, summaryLine, tabBadges, tableTarget, taskStat, visibleLinks,
  type DecisionItem, type DriftItem, type FileItem, type IfaceItem, type DataItem, type TaskInfo,
} from '../src/features/design/model.ts';

const dec = (p: Partial<DecisionItem>): DecisionItem => ({
  id: 'd1', tdKey: 'TD-01', area: '데이터', title: '운영 DB', choice: 'PostgreSQL 16', authority: 'lead', level: 'must', condition: '', status: 'fixed',
  reason: '등록 제약', alternatives: '', by: '팀장', at: '2026-10-27T00:40:00.000Z', updatedAt: '2026-10-27T00:40:00.000Z', ...p,
} as DecisionItem);
const drift = (p: Partial<DriftItem>): DriftItem => ({
  id: 'r1', itemKey: 'PATCH /api/tasks/:taskKey', kind: 'REST', where: 'main', text: '응답에 updatedBy', taskKey: 'TASK-0005', compat: 'compatible',
  status: 'open', updatedAt: '2026-11-05T00:00:00.000Z', ...p,
} as DriftItem);
const iface = (key: string, kind: string, taskKey: string | null = 'TASK-0005'): IfaceItem => ({ key, name: key, kind, taskKey, status: 'ok' } as IfaceItem);
const data = (key: string, store: string, taskKey: string | null = 'TASK-0004'): DataItem => ({ key, name: key.replace(/^\w+:/, ''), store, taskKey, status: 'ok' } as DataItem);
const tasks = new Map<string, TaskInfo>([
  ['TASK-0004', { status: 'qa', verif: 'none' }], ['TASK-0005', { status: 'running', verif: 'none' }],
  ['TASK-0001', { status: 'done', verif: 'pass' }], ['TASK-0002', { status: 'done', verif: 'none' }], ['TASK-0009', { status: 'cancelled', verif: 'none' }],
]);

describe('담당 Task 상태로 항목 상태 계산(G L452, P Sel.dsStat)', () => {
  it('Task 없음·계획 → 계획, 진행 → 구현 중 · 브랜치, 완료 → 구현됨/검증됨, 취소 → 폐기', () => {
    expect(taskStat(undefined)).toEqual(['계획', 'vf v-none']);
    expect(taskStat({ status: 'planning', verif: 'none' })).toEqual(['계획', 'vf v-none']);
    expect(taskStat(tasks.get('TASK-0005'))).toEqual(['구현 중 · 브랜치', 'vf v-run']);
    expect(taskStat(tasks.get('TASK-0004'))).toEqual(['구현 중 · 브랜치', 'vf v-run']);
    expect(taskStat(tasks.get('TASK-0002'))).toEqual(['구현됨', 'vf v-pass']);
    expect(taskStat(tasks.get('TASK-0001'))).toEqual(['검증됨', 'vf v-pass']);
    expect(taskStat(tasks.get('TASK-0009'))).toEqual(['폐기', 'vf v-none']);
  });
});

describe('기술 결정(P L1520–1532, TECH_*)', () => {
  it('권한·수준·상태 문구와 변경 제안 가능 여부', () => {
    const must = decisionView(dec({}));
    expect(must).toMatchObject({ authL: '팀장 지정 · 필수', authC: 'sc sc-ok', stL: '확정', stC: 'vf v-pass', pending: false, canChg: false });
    const cond = decisionView(dec({ level: 'cond', status: 'approved' }));
    expect(cond).toMatchObject({ authL: '팀장 지정 · 조건부 선호', canChg: true });
    const agent = decisionView(dec({ authority: 'agent', level: null, status: 'approved' }));
    expect(agent).toMatchObject({ authL: 'Agent 제안 → 팀장 승인', authC: 'sc sc-none', stL: '승인됨', canChg: true });
    expect(decisionView(dec({ authority: 'free', level: null, status: 'noted' }))).toMatchObject({ authL: 'Agent 재량 (기록)', stL: '기록', canChg: false });
    expect(decisionView(dec({ authority: 'agent', level: null, status: 'pending' }))).toMatchObject({ stL: '승인 대기', stC: 'vf v-run', pending: true, canChg: false });
    expect(decisionView(dec({ authority: 'agent', level: null, status: 'rejected' }))).toMatchObject({ stL: '반려', rowC: 'dec-row off', pending: false });
  });
  it('변경 제안: 승인 전에는 기존 선택을 보이고 「기존 → 새 선택 — 이유」를 덧붙인다', () => {
    const v = decisionView(dec({ authority: 'agent', level: null, status: 'change', choice: 'SSE', change: { choice: 'WebSocket', reason: '양방향 필요', previousStatus: 'approved' } }));
    expect(v).toMatchObject({ stL: '변경 제안 — 승인 대기', pending: true, isChg: true, chgL: 'SSE → WebSocket — 양방향 필요' });
  });
  it('조건부 선호의 조건 충족 판단을 조건 옆에 보인다', () => {
    expect(decisionView(dec({ level: 'cond', status: 'pending', condition: '시계열이면 QuestDB', conditionResult: 'met' })).condL).toBe('시계열이면 QuestDB (조건 충족 판단: 충족)');
    expect(decisionView(dec({ condition: '' })).condL).toBe('');
  });
  it('권한별 묶음 순서: 팀장 지정 → Agent 제안 → 재량, 빈 묶음 없음', () => {
    const g = decisionGroups([dec({ id: 'a', authority: 'free' }), dec({ id: 'b', authority: 'lead' })]);
    expect(g.map((x) => [x.l, x.rows.map((r) => r.id)])).toEqual([['팀장 지정 — 필수 · 조건부 선호 · 금지', ['b']], ['Agent 재량 — 기록만', ['a']]]);
  });
  it('계약 반영에 쓸 수 있는 결정은 승인됨(approved)만', () => {
    expect(approvedDecisions([dec({ id: 'a', status: 'approved' }), dec({ id: 'b', status: 'fixed' }), dec({ id: 'c', status: 'pending' })]).map((d) => d.id)).toEqual(['a']);
  });
});

describe('불일치(G L449·1058, contracts §2.3)', () => {
  it('호환 판정 문구: unchecked는 「대조 안 함」이고 호환으로 보이지 않는다', () => {
    expect(compatLabel('compatible')).toEqual(['호환', 'sc sc-ok']);
    expect(compatLabel('breaking')).toEqual(['호환 깨짐', 'sc sc-bad']);
    expect(compatLabel('unchecked')).toEqual(['대조 안 함', 'sc sc-warn']);
  });
  it('호환 차이: 계약에 반영·코드 수정 요청 모두 가능, 결정 필요 없음', () => {
    expect(driftView(drift({}))).toMatchObject({ open: true, waiting: false, stL: '미해결', canContract: true, canCode: true, needsDecision: false });
  });
  it('호환 깨짐: 계약 반영은 승인된 결정 ID가 필요하다', () => {
    expect(driftView(drift({ compat: 'breaking' }))).toMatchObject({ canContract: true, needsDecision: true });
  });
  it('대조 안 함: 계약 반영 불가(서버 거부), 코드 수정 요청만, 안내 문구', () => {
    const v = driftView(drift({ compat: 'unchecked', itemKey: 'file:contracts/db/neo4j/model.cypher', taskKey: null }));
    expect(v).toMatchObject({ canContract: false, canCode: false, stL: '대조 안 함' });
    expect(v.note).toContain('불일치 0건이 아닙니다');
    expect(driftView(drift({ compat: 'unchecked' }))).toMatchObject({ canContract: false, canCode: true });
  });
  it('계약 반영 job 대기: 결과 커밋 보고 전에는 해결로 보이지 않고 버튼 대신 다시 요청만', () => {
    const v = driftView(drift({ resolution: { how: 'contract', jobId: 'job-1' } }));
    expect(v).toMatchObject({ open: true, waiting: true, stL: '계약 반영 대기', stC: 'vf v-run', canContract: false, canCode: false, canRetry: true });
    expect(v.resL).toContain('결과 커밋');
  });
  it('해결됨: 처리 방법·결과 커밋·메시지를 보인다', () => {
    expect(driftView(drift({ status: 'done', resolution: { how: 'contract', jobId: 'job-1', resultCommit: 'abcdef1234567890' } })))
      .toMatchObject({ open: false, stL: '해결됨', stC: 'vf v-pass', resL: '계약에 반영 — 결과 커밋 abcdef1' });
    expect(driftView(drift({ status: 'done', resolution: { how: 'code', messageId: 'm1' } })).resL).toBe('코드 수정 요청 → TASK-0005 메시지로 전달');
    expect(driftView(drift({ status: 'done', resolution: { resolvedBy: 'comparison', commit: '1234567aaaa' } })).resL).toBe('다음 대조에서 일치 확인 — 커밋 1234567');
  });
  it('항목 표시: 열린 불일치가 있으면 「불일치」, 대조 안 함만 있으면 「대조 안 함」', () => {
    const list = [drift({ itemKey: 'A' }), drift({ itemKey: 'B', compat: 'unchecked' }), drift({ itemKey: 'C', status: 'done' })];
    expect(driftMark(list, 'A')).toEqual(['불일치', 'sc sc-bad']);
    expect(driftMark(list, 'B')).toEqual(['대조 안 함', 'sc sc-warn']);
    expect(driftMark(list, 'C')).toBeNull();
  });
});

describe('요약·배지(P dsVM sumL·bd)', () => {
  const decs = [dec({ id: 'a' }), dec({ id: 'b', authority: 'agent', status: 'pending' }), dec({ id: 'c', authority: 'agent', status: 'change' })];
  const drifts = [drift({ id: '1' }), drift({ id: '2', compat: 'unchecked' }), drift({ id: '3', status: 'done' })];
  it('요약 줄에 불일치와 대조 안 함을 따로 센다', () => {
    expect(summaryLine(3, decs, 27, 16, drifts)).toBe('설계 v3 · 기술 결정 3 (승인 대기 2) · 인터페이스 27 · 데이터 항목 16 · 불일치 1 · 대조 안 함 1');
    expect(summaryLine(null, [], 0, 0, [])).toBe('설계 v0 · 기술 결정 0 · 인터페이스 0 · 데이터 항목 0');
  });
  it('탭 배지: 결정은 승인 대기, 변경 · 불일치는 열린 것 전체(대조 안 함 포함)', () => {
    expect(tabBadges(decs, 27, 16, drifts)).toEqual({ dec: [2, 'tab-c alert'], iface: [27, 'tab-c'], data: [16, 'tab-c'], chg: [2, 'tab-c alert'] });
  });
});

describe('구성도·계약 파일', () => {
  const decs = [dec({ id: 'd-pg', tdKey: 'TD-01' }), dec({ id: 'd-q', tdKey: 'TD-03', status: 'pending' }), dec({ id: 'd-x', tdKey: 'TD-09', status: 'rejected' })];
  const comps = [
    { id: 'x', layer: '데이터', name: 'X', tech: 't', note: 'n', decisionId: 'd-x' }, { id: 'q', layer: '데이터', name: 'QuestDB', tech: '시계열', note: '', decisionId: 'd-q' },
    { id: 'pg', layer: '데이터', name: 'PostgreSQL', tech: '운영', note: '', decisionId: 'd-pg' }, { id: 'web', layer: '클라이언트', name: 'Web', tech: 'React', note: '', decisionId: null },
    { id: 'e', layer: '기타', name: 'E', tech: '', note: '', decisionId: null },
  ];
  it('계층 순서(클라이언트·서버·팀장 PC·데이터 다음 나머지), 승인 대기는 점선, 반려는 취소선', () => {
    const ls = layers(comps, decs);
    expect(ls.map((l) => l.l)).toEqual(['클라이언트', '데이터', '기타']);
    expect(ls[1]?.comps.map((c) => [c.name, c.cls, c.decL])).toEqual([['X', 'ds-comp off', 'TD-09 반려'], ['QuestDB', 'ds-comp pend', 'TD-03 승인 대기'], ['PostgreSQL', 'ds-comp', 'TD-01 확정']]);
  });
  it('반려된 구성 요소의 연결은 숨긴다', () => {
    const links = [{ from: 'web', to: 'pg', via: 'REST', contractPath: 'contracts/api/openapi.yaml' }, { from: 'pg', to: 'x', via: 'sync', contractPath: null }];
    expect(visibleLinks(comps, links, decs)).toEqual([{ from: 'Web', to: 'PostgreSQL', how: 'REST', file: 'contracts/api/openapi.yaml' }]);
  });
  const files = [
    { path: 'contracts/api/openapi.yaml', kind: 'REST', format: 'OpenAPI 3.1', status: 'ok', commit: 'a41f0c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', itemCount: 4, error: null, sourceCommit: 'a41f0c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { path: 'contracts/db/neo4j/model.cypher', kind: 'Neo4j', format: 'Cypher', status: 'error', commit: 'b000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', itemCount: 7, error: '42행 문법 오류', sourceCommit: '3be19d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { path: 'contracts/cache/redis-keys.yaml', kind: 'Redis', format: 'YAML', status: 'ok', commit: 'a41f0c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', itemCount: 0, error: null, sourceCommit: 'a41f0c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  ] as FileItem[];
  it('파일 상태: 읽음·브랜치 초안·읽기 실패(마지막 성공 커밋), 추출 못 한 파일은 대조 안 함', () => {
    const rows = fileRows(files, [drift({ itemKey: 'file:contracts/cache/redis-keys.yaml', compat: 'unchecked' })]);
    expect(rows.map((r) => [r.stL, r.stC, r.commit, r.unchecked])).toEqual([
      ['읽음', 'vf v-pass', 'a41f0c2', false], ['읽기 실패', 'vf v-fail', '3be19d0 (마지막 성공)', false], ['읽음', 'vf v-pass', 'a41f0c2', true],
    ]);
  });
  it('읽기 실패 배너 문구', () => {
    expect(parseErrors(files)).toEqual(['contracts/db/neo4j/model.cypher — 42행 문법 오류 · 마지막 성공 버전(3be19d0)으로 표시합니다.']);
  });
});

describe('인터페이스·데이터 목록', () => {
  const ifs = [iface('GET /api/tasks', 'REST'), iface('PATCH /api/tasks/:taskKey', 'REST'), iface('/runner/ws', 'WebSocket', 'TASK-0012'), iface('runner.attempt.events', 'Kafka', null)];
  it('방식 필터 버튼 건수(원본 IK, Kafka는 「이벤트 (Kafka)」)', () => {
    expect(kindCounts(ifs)).toEqual([['', '전체', 4], ['REST', 'REST', 2], ['WebSocket', 'WebSocket', 1], ['SSE', 'SSE', 0], ['Kafka', '이벤트 (Kafka)', 1]]);
  });
  it('필터·검색(이름, 대소문자 무시)과 불일치 표시', () => {
    const rows = itemRows(ifs, { kind: 'REST', q: 'patch' }, tasks, [drift({})]);
    expect(rows.map((r) => [r.key, r.kindL, r.stL, r.task, r.mark?.[0]])).toEqual([['PATCH /api/tasks/:taskKey', 'REST', '구현 중 · 브랜치', 'TASK-0005', '불일치']]);
    expect(itemRows(ifs, { kind: '', q: '' }, tasks, []).find((r) => r.key === 'runner.attempt.events')?.task).toBe('—');
  });
  it('저장소 건수·종류 문구', () => {
    const ds = [data('postgres:tasks', 'postgres'), data('neo4j:Task', 'neo4j'), data('redis:lock', 'redis')];
    expect(storeCounts(ds)).toEqual([['postgres', 'PostgreSQL', 1], ['neo4j', 'Neo4j', 1], ['questdb', 'QuestDB', 0], ['redis', 'Redis', 1]]);
    expect(itemRows(ds, { store: 'redis', q: '' }, tasks, []).map((r) => r.kindL)).toEqual(['Redis 키']);
  });
  it('REST의 「읽고 쓰는 테이블」 → PostgreSQL 항목 key(이름만 와도 postgres: 를 붙인다), 중복 제거', () => {
    expect(tableTarget(['tasks', 'postgres:tasks', 'postgres:wbs_nodes'])).toEqual([{ n: 'tasks', key: 'postgres:tasks' }, { n: 'wbs_nodes', key: 'postgres:wbs_nodes' }]);
  });
});
