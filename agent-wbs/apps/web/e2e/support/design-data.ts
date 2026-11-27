/**
 * M6-07 설계 화면 E2E용 가짜 설계 원장 서버.
 *
 * - 값은 원본 Mock(DS_MOCK P L3559–3640, Task 기술 설계는 fixtures/prototype-mock.json)과 같다.
 *   왜: 시각 비교에서 원본과 같은 내용이 보여야 차이가 「모양」 차이만 남는다.
 * - 원본에 없는 서버 규칙(M6-05)도 그대로 흉내 낸다.
 *   - 승인·반려·변경 제안은 updatedAt이 다르면 409 VERSION_CONFLICT, 상태가 맞지 않으면 409 INVALID_TRANSITION.
 *   - 불일치 「계약에 반영」은 202 { jobId }만 주고 open을 유지한다(결과 커밋 보고 전 resolved 금지, contracts §2.3).
 *   - 호환을 깨는(breaking) 반영은 승인된(approved) 결정 ID가 없으면 409 INVALID_TRANSITION, 대조 안 함(unchecked)은 반영 거부.
 *   - 「코드 수정 요청」은 바로 done(실제 메시지 생성)이다.
 * - 응답 모양은 계약 타입(ResponseOf)이라 서버 계약과 어긋나면 typecheck가 실패한다.
 */
import type { Route, Request } from '@playwright/test';
import type { ResponseOf } from '../../src/shared/api/contract.ts';
import raw from '../fixtures/prototype-mock.json' with { type: 'json' };
import { errorBody, json, type FakeApi } from './fake-api.ts';

type Decision = ResponseOf<'listDecisions'>['items'][number];
type Drift = ResponseOf<'listDrifts'>['items'][number];
type Overview = ResponseOf<'getDesign'>;
type IfaceDetail = ResponseOf<'getInterface'>;
type DataDetail = ResponseOf<'getDataItem'>;
type Ownership = ResponseOf<'getOwnership'>['items'][number];

/* eslint-disable @typescript-eslint/no-explicit-any -- 원본 Mock JSON은 타입이 없다 */
const P = raw as any;

/** KST 'YYYY-MM-DD HH:mm' → ISO */
export const kst = (s: string) => new Date(`${s.replace(' ', 'T')}:00+09:00`).toISOString();
const SHA = { a41f0c2: 'a41f0c2'.padEnd(40, '0'), '9c2e7aa': '9c2e7aa'.padEnd(40, '0'), '3be19d0': '3be19d0'.padEnd(40, '0') };
const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const D = (n: number, area: string, title: string, choice: string, authority: Decision['authority'], level: Decision['level'], status: Decision['status'], by: string, at: string, condition: string, reason: string, alternatives: string): Decision =>
  ({ id: id('d', n), tdKey: `TD-${String(n).padStart(2, '0')}`, area, title, choice, authority, level, condition, status, reason, alternatives, by, at: kst(at), updatedAt: kst(at) });

export const decisions = (): Decision[] => [
  D(1, '데이터', '운영 DB', 'PostgreSQL 16', 'lead', 'must', 'fixed', '팀장', '2026-10-27 09:40', '', '프로젝트 등록 시 기술 제약 (필수)', ''),
  D(2, '데이터', '캐시 · 잠금 · 하트비트', 'Redis 7', 'lead', 'must', 'fixed', '팀장', '2026-10-27 09:40', '', '프로젝트 등록 시 기술 제약 (필수)', ''),
  D(3, '데이터', '시계열 데이터', 'QuestDB', 'lead', 'cond', 'pending', 'Planning Agent', '2026-11-06 14:20', '시계열 데이터(시간 순 대량 쓰기 · 구간 집계 · 보관 기간)가 있으면 QuestDB 사용',
    '조건 충족 판단 — Runner 자원 관측 샘플: 세션별 CPU · 메모리 10초 간격, 하루 약 70만 행, 조회는 1분 · 1시간 구간 평균, 원본 14일 보관. PostgreSQL에 두면 운영 테이블과 쓰기 경합.', 'PostgreSQL 시간 파티션 (규모가 작으면 충분) — 기각: 보관 · 집계 관리를 직접 구현해야 함'),
  D(4, '운영', '외부 클라우드 관리형 서비스', '사용 금지', 'lead', 'ban', 'fixed', '팀장', '2026-10-27 09:40', '', '팀장 PC(WSL)에서 운영 — 외부 의존 없음', ''),
  D(5, '데이터', '의존성 · 설계 항목 영향 분석', 'Neo4j 5', 'agent', null, 'approved', 'Planning Agent', '2026-10-27 10:05', '',
    'Task · 설계 항목 · 화면의 다단계 연결(「이 테이블을 바꾸면 어떤 API · 화면 · Task가 영향받나」)을 반복 조회 — 깊이 3~6 탐색', 'PostgreSQL 재귀 CTE — 기각: 깊이가 깊고 경로 조건이 복잡해 쿼리 유지가 어려움'),
  D(6, '통신', 'Runner 실행 이벤트 수집', 'Kafka (KRaft 단일 노드)', 'agent', null, 'approved', 'Planning Agent', '2026-10-27 10:05', '',
    'Runner 이벤트를 일정 재조정 · 보고서 · Neo4j 반영이 각자 소비, 서버 재시작 시 재처리 필요', 'PostgreSQL 이벤트 테이블 + 폴링 — 기각: 소비자별 진행 위치 · 재처리를 직접 구현'),
  D(7, '통신', 'Runner ↔ 서버 제어 채널', 'WebSocket', 'agent', null, 'approved', 'Planning Agent', '2026-10-27 10:05', '', '실행 시작 · 중단 · 실행 중 지시 전달이 서버 → Runner 방향 — 양방향 필요', 'HTTP 폴링 — 기각: 지시 전달 지연'),
  D(8, '통신', '화면 실시간 갱신', 'SSE (Server-Sent Events)', 'agent', null, 'approved', 'Planning Agent', '2026-10-27 10:05', '', '프로토타입 분석: 실행 상태 · 알림 · 진행률 화면이 서버 → 화면 단방향 갱신만 필요', 'WebSocket — 기각: 화면 쪽은 양방향 불필요, 재연결 · 프록시 처리가 단순한 SSE 선택'),
  D(9, '형식', 'Runner 메시지 직렬화', 'JSON + JSON Schema', 'agent', null, 'approved', 'Planning Agent', '2026-10-27 10:05', '', '메시지 초당 수십 건 수준 — 크기 · 속도 이점보다 디버깅 용이성이 큼', 'Protocol Buffers — 기각: 현재 규모에서 이점 적음 (메시지 초당 1천 건 이상이면 재검토)'),
  D(10, '운영', '캐시 만료 시간 (WBS 트리 요약)', '5분 + 변경 시 즉시 무효화', 'free', null, 'noted', 'Claude (TASK-0005)', '2026-11-05 16:12', '', '되돌리기 쉬움 — 기록만', ''),
  D(11, '데이터', 'tasks.wbs_node_id 인덱스', 'BTREE 추가', 'free', null, 'noted', 'Claude (TASK-0004)', '2026-11-04 11:30', '', '되돌리기 쉬움 — 기록만', ''),
];

const comps: Overview['components'] = [
  { id: 'web', layer: '클라이언트', name: 'Web (FE)', tech: 'React · TypeScript · Vite · Mantine', note: '팀장 브라우저', decisionId: null },
  { id: 'api', layer: '서버', name: 'API 서버', tech: 'Node.js · Fastify · Drizzle', note: 'REST · SSE · Runner WebSocket', decisionId: null },
  { id: 'worker', layer: '서버', name: '이벤트 소비자', tech: 'Node.js', note: 'Kafka 소비 → 일정 재조정 · 보고서 · Neo4j 반영', decisionId: null },
  { id: 'runner', layer: '팀장 PC', name: 'Runner', tech: 'Node.js · WSL', note: 'Claude · Codex CLI 실행 · worktree 관리', decisionId: null },
  { id: 'pg', layer: '데이터', name: 'PostgreSQL 16', tech: '운영 DB', note: '원본 데이터', decisionId: id('d', 1) },
  { id: 'neo', layer: '데이터', name: 'Neo4j 5', tech: '그래프 DB', note: '영향 분석용 복제', decisionId: id('d', 5) },
  { id: 'qdb', layer: '데이터', name: 'QuestDB', tech: '시계열 DB', note: 'Runner 자원 관측 (승인 대기)', decisionId: id('d', 3) },
  { id: 'redis', layer: '데이터', name: 'Redis 7', tech: '캐시 · 잠금', note: '하트비트 · 실행 잠금 · 요약 캐시', decisionId: id('d', 2) },
  { id: 'kafka', layer: '데이터', name: 'Kafka', tech: '이벤트 스트림', note: 'Runner 실행 이벤트', decisionId: id('d', 6) },
];
const L = (from: string, to: string, via: string, contractPath: string) => ({ from, to, via, contractPath });
const links: Overview['links'] = [
  L('web', 'api', 'REST', 'contracts/api/openapi.yaml'), L('api', 'web', 'SSE', 'contracts/events/asyncapi.yaml'), L('runner', 'api', 'WebSocket', 'contracts/events/asyncapi.yaml'),
  L('runner', 'kafka', 'Kafka 발행', 'contracts/events/asyncapi.yaml'), L('kafka', 'worker', 'Kafka 소비', 'contracts/events/asyncapi.yaml'), L('api', 'pg', 'SQL (Drizzle)', 'contracts/db/postgres/migrations'),
  L('worker', 'neo', 'Cypher', 'contracts/db/neo4j/model.cypher'), L('api', 'neo', 'Cypher (영향 분석 조회)', 'contracts/db/neo4j/model.cypher'), L('api', 'redis', 'Redis 명령', 'contracts/cache/redis-keys.yaml'),
  L('runner', 'qdb', 'ILP 수집 (승인 시)', 'contracts/db/questdb/tables.sql'),
];
const F = (path: string, kind: string, format: string, status: 'ok' | 'draft' | 'error', commit: string | null, itemCount: number): Overview['files'][number] =>
  ({ path, kind, format, status, commit, itemCount, error: null, raw: null, sourceCommit: commit });
const files = (): Overview['files'] => [
  F('contracts/api/openapi.yaml', 'REST', 'OpenAPI 3.1', 'ok', SHA.a41f0c2, 23),
  F('contracts/events/asyncapi.yaml', '이벤트 · WebSocket · SSE', 'AsyncAPI 3.0', 'ok', SHA.a41f0c2, 4),
  F('contracts/db/postgres/migrations/*.sql', 'PostgreSQL', 'SQL 마이그레이션 (기준) — src/의 Drizzle 스키마는 이것과 대조', 'ok', SHA['9c2e7aa'], 4),
  F('contracts/db/neo4j/model.cypher + migrations/', 'Neo4j', '모델 정의 (라벨 · 관계 · 제약) + Cypher 마이그레이션', 'ok', SHA['3be19d0'], 7),
  F('contracts/db/questdb/tables.sql', 'QuestDB', 'CREATE TABLE (기준 타임스탬프 · 파티션 · 보관 기간)', 'draft', null, 1),
  F('contracts/cache/redis-keys.yaml', 'Redis', '키 카탈로그 (YAML)', 'ok', SHA.a41f0c2, 4),
];
const versions: Overview['versions'] = [
  { v: 3, at: kst('2026-11-05 17:40'), by: '팀장 승인 (CP-004)', note: 'Runner API 계약 16개 · Runner WebSocket · Kafka 토픽 2개 추가', breaking: false },
  { v: 2, at: kst('2026-10-31 15:10'), by: 'TASK-0004 병합', note: 'PostgreSQL 테이블 4개 (wbs_nodes · tasks · task_dependencies · checklist_items)', breaking: false },
  { v: 1, at: kst('2026-10-27 10:20'), by: '기술 결정 확정 (팀장)', note: '기술 결정 9건 확정 · 계약 파일 골격 생성', breaking: false },
];

/* ---- 인터페이스·데이터: REST·PostgreSQL은 Task 기술 설계(원본 Sel.dsRest·dsPg), 나머지는 DS_MOCK ---- */
export interface Item { key: string; name: string; description?: string | null; taskKey: string | null; kind?: string; store?: string; path: string; content: any }
function fromTasks(): Item[] {
  const out: Item[] = [];
  const rest: { name: string; tables: string[] }[] = [];
  for (const k of Object.keys(P.tasks).sort()) {
    const t = P.tasks[k];
    if (t.status === 'cancelled') continue;
    for (const s of t.design ?? []) for (const e of s.ents ?? []) {
      if (s.kind === 'API') {
        const name = `${String(e.f.method)} ${String(e.f.path)}`;
        rest.push({ name, tables: e.b.tables ?? [] });
        out.push({ key: name, name, description: e.f.desc || null, kind: 'REST', taskKey: k, path: 'contracts/api/openapi.yaml', content: { type: 'REST', auth: e.f.auth ?? '', request: e.b.request ?? '', response: e.b.response ?? '', validation: e.b.validation ?? [], errors: e.b.errors ?? [], tables: (e.b.tables ?? []).map((n: string) => `postgres:${n}`) } });
      }
    }
  }
  for (const k of Object.keys(P.tasks).sort()) {
    const t = P.tasks[k];
    if (t.status === 'cancelled') continue;
    for (const s of t.design ?? []) for (const e of s.ents ?? []) {
      if (s.kind === 'DB') {
        const n = String(e.f.name);
        const usedBy = rest.filter((r) => r.tables.includes(n)).map((r) => r.name);
        out.push({ key: `postgres:${n}`, name: n, description: `${String(e.f.desc ?? '')}${usedBy.length ? ` · API ${String(usedBy.length)}개 사용` : ''}`, store: 'postgres', taskKey: k, path: 'contracts/db/postgres/migrations/*.sql', content: {
          type: 'postgres', constraints: [],
          columns: (e.b.columns ?? []).map((c: any) => ({ name: c.name, type: c.type, nullable: !!c.nullable, pk: !!c.pk, unique: !!c.unique, fk: c.fk || null, default: c.def || null, desc: c.desc ?? '' })),
          indexes: (e.b.indexes ?? []).map((x: any) => ({ name: x.name, columns: x.cols, kind: x.kind })),
          usedBy,
        } });
      }
    }
  }
  return out;
}
const msg = (name: string, direction: string, schema: string) => ({ name, direction, schema });
const IFACES: Item[] = [
  { key: 'WS /runner/ws', name: '/runner/ws', description: 'Runner ↔ 서버 제어 채널', kind: 'WebSocket', taskKey: 'TASK-0012', path: 'contracts/events/asyncapi.yaml', content: { type: 'message', auth: 'Runner 토큰 (등록 시 발급)', topic: null, decisionKeys: ['TD-07'],
    messages: [msg('hello', 'Runner → 서버', '{ runnerId, version, host: { cores, memGB }, cli: { claude, codex } }'), msg('attempt.start', '서버 → Runner', '{ attemptId, taskKey, agent, model, effort, worktree, instructions, subBudget }'),
      msg('instruction.deliver', '서버 → Runner', '{ attemptId, messageId, text }'), msg('attempt.stop', '서버 → Runner', '{ attemptId, reason }'), msg('heartbeat', 'Runner → 서버', '{ at, sessions, cap }  // 10초')],
    rules: ['연결 끊김 30초 → Runner 오프라인 처리', '메시지마다 msgId — 재전송 시 중복 무시'] } },
  { key: 'SSE GET /api/events', name: 'GET /api/events', description: '화면 실시간 갱신', kind: 'SSE', taskKey: 'TASK-0012', path: 'contracts/events/asyncapi.yaml', content: { type: 'message', auth: '팀장 세션', topic: null, decisionKeys: ['TD-08'],
    messages: [msg('task.updated', '서버 → 화면', '{ taskKey, status, verif, updatedAt }'), msg('attempt.updated', '서버 → 화면', '{ attemptId, status, progress }'), msg('alert.created', '서버 → 화면', '{ kind, text, taskKey? }')],
    rules: ['Last-Event-ID로 재연결 시 놓친 이벤트 재전송 (최근 5분)'] } },
  { key: 'runner.attempt.events', name: 'runner.attempt.events', description: 'Runner 실행 이벤트 (시작 · 진행 · 종료 · 산출물)', kind: 'Kafka', taskKey: 'TASK-0012', path: 'contracts/events/asyncapi.yaml', content: { type: 'message', auth: '—', rules: [], decisionKeys: ['TD-06'],
    messages: [msg('AttemptStarted', 'Runner → 토픽', '{ attemptId, taskKey, agent, at }'), msg('AttemptProgress', 'Runner → 토픽', '{ attemptId, step, subObserved, at }'), msg('AttemptFinished', 'Runner → 토픽', '{ attemptId, result, tokens, durationMs, at }')],
    topic: { key: 'taskKey (같은 Task 이벤트 순서 보장)', partitions: '3', retention: '7일', delivery: '최소 1회 — 소비자는 eventId로 중복 제거', dlq: 'runner.attempt.events.dlq', compat: '하위 호환만 허용 (필드 추가 OK · 삭제 · 타입 변경 금지)', consumers: ['schedule-replanner', 'report-builder', 'graph-sync'] } } },
  { key: 'design.item.changed', name: 'design.item.changed', description: '설계 항목 변경 → Neo4j 영향 그래프 반영', kind: 'Kafka', taskKey: 'TASK-0010', path: 'contracts/events/asyncapi.yaml', content: { type: 'message', auth: '—', rules: [], decisionKeys: ['TD-06'],
    messages: [msg('DesignItemChanged', 'API 서버 → 토픽', '{ itemKey, kind, change, taskKey, version, at }')],
    topic: { key: 'itemKey', partitions: '1', retention: '30일', delivery: '최소 1회', dlq: '—', compat: '하위 호환만 허용', consumers: ['graph-sync'] } } },
];
const NEO = 'contracts/db/neo4j/model.cypher + migrations/';
const neoL = (n: string, props: string, note: string, cons: string): Item => ({ key: `neo4j:${n}`, name: `:${n}`, description: props, store: 'neo4j', taskKey: 'TASK-0010', path: NEO, content: { type: 'neo4j-label', props, note, constraints: cons ? [cons] : [] } });
const neoR = (n: string, from: string, to: string, props: string): Item => ({ key: `neo4j:${n}`, name: `(:${from})-[:${n}]->(:${to})`, description: props || '속성 없음', store: 'neo4j', taskKey: 'TASK-0010', path: NEO, content: { type: 'neo4j-relation', from, to, props } });
const redis = (p: string, use: string, value: string, ttl: string, invalidation: string): Item => ({ key: `redis:${p}`, name: p, description: `${use} · TTL ${ttl}`, store: 'redis', taskKey: 'TASK-0012', path: 'contracts/cache/redis-keys.yaml', content: { type: 'redis', use, value, ttl, invalidation, persistence: '불필요' } });
const DATA: Item[] = [
  neoL('Task', 'taskKey (UNIQUE) · title · status', 'PostgreSQL tasks 복제', 'CREATE CONSTRAINT task_key FOR (t:Task) REQUIRE t.taskKey IS UNIQUE'),
  neoL('DesignItem', 'itemKey (UNIQUE) · kind · name', 'API · 테이블 · 채널 · 토픽', 'CREATE CONSTRAINT item_key FOR (d:DesignItem) REQUIRE d.itemKey IS UNIQUE'),
  neoL('Screen', 'screenId (UNIQUE) · name', '프로토타입 화면', ''),
  neoR('DEPENDS_ON', 'Task', 'Task', 'type (FS | SS)'), neoR('TOUCHES', 'Task', 'DesignItem', 'role (만듦 | 바꿈 | 사용 | 검증)'),
  neoR('READS_WRITES', 'DesignItem', 'DesignItem', 'mode (R | W) — API → 테이블'), neoR('SHOWS', 'Screen', 'DesignItem', '없음'),
  { key: 'questdb:runner_samples', name: 'runner_samples', description: '파티션 DAY · 보관 14일 (TTL)', store: 'questdb', taskKey: null, path: 'contracts/db/questdb/tables.sql', content: {
    type: 'questdb', timestamp: 'ts (기준 타임스탬프)', partition: 'DAY', retention: '14일 (TTL)', dedup: 'ts, runner_id, session_id', symbols: 'runner_id, session_id, agent',
    columns: 'cpu_pct DOUBLE · mem_mb DOUBLE · subs INT', ingest: 'ILP (Runner → QuestDB 9009)', aggregation: '1분 · 1시간 평균은 QuestDB SAMPLE BY 조회 — PostgreSQL로 보내지 않음' } },
  redis('runner:{runnerId}:hb', '하트비트', 'JSON { at, sessions }', '30초', '만료 = 오프라인'), redis('lock:task:{taskKey}', '실행 잠금 (같은 Task 동시 실행 방지)', 'attemptId', '15분 (갱신)', '실행 종료 시 삭제'),
  redis('cache:wbs:{projectId}:tree', 'WBS 트리 요약 캐시', 'JSON', '5분', 'Task · 의존성 변경 시 삭제'), redis('rate:api:{session}', '요청 제한', '카운터', '1분', '—'),
];

const own: Ownership[] = [
  { data: 'Task · 의존성 · 체크리스트', source: 'PostgreSQL', copy: 'Neo4j (Task · DEPENDS_ON)', sync: 'design.item.changed / task 변경 이벤트 → graph-sync', lag: '수 초' },
  { data: '설계 항목 연결 (API ↔ 테이블 ↔ 화면)', source: '저장소 계약 파일', copy: 'Neo4j (DesignItem · READS_WRITES · SHOWS)', sync: 'main 병합 시 Runner가 파싱 → 이벤트', lag: '병합 후 1분' },
  { data: '실행 시도 · 결과', source: 'PostgreSQL', copy: '—', sync: 'Kafka runner.attempt.events → 서버가 기록', lag: '수 초' },
  { data: 'Runner 자원 관측 샘플', source: 'QuestDB (승인 시)', copy: '—', sync: 'Runner ILP 직접 수집', lag: '—' },
  { data: '하트비트 · 실행 잠금 · 요약 캐시', source: 'Redis', copy: '—', sync: '원본 아님 — 잃어도 재계산', lag: '—' },
];

const R = (n: number, itemKey: string, kind: string, where: string, text: string, taskKey: string | null, compat: Drift['compat'], status: Drift['status'], resolution: Record<string, unknown> = {}): Drift =>
  ({ id: id('r', n), displayKey: `DR-${String(n).padStart(2, '0')}`, itemKey, kind, where, text, taskKey, compat, status, updatedAt: kst('2026-11-05 18:00'), resolution });
export const drifts = (): Drift[] => [
  R(1, 'PATCH /api/tasks/:taskKey', 'REST', 'feature/TASK-0005 브랜치', '코드 응답에 `updatedBy` 필드가 있으나 계약(openapi.yaml)에는 없음', 'TASK-0005', 'compatible', 'open'),
  R(2, 'postgres:tasks', 'PostgreSQL', 'feature/TASK-0004 브랜치 마이그레이션', '`tasks.deleted_at` 부분 인덱스가 마이그레이션에만 있고 schema.ts에 없음', 'TASK-0004', 'compatible', 'open'),
  R(3, 'runner.attempt.events', 'Kafka', 'main', '계약의 AttemptProgress에 `subObserved` 필드 추가됨 — 소비자 report-builder가 아직 모름 (호환 변경)', 'TASK-0012', 'compatible', 'done', { how: 'contract', jobId: 'job-0', resultCommit: SHA.a41f0c2 }),
];

export interface DesignData {
  decisions: Decision[];
  components: Overview['components'];
  links: Overview['links'];
  files: Overview['files'];
  versions: Overview['versions'];
  items: Item[];
  ownership: Ownership[];
  drifts: Drift[];
  seq: number;
  /** 브랜치 조회(?ref=agent/TASK-…)에 줄 초안. 서버는 ref별 캐시를 따로 둔다(M6-05). 없는 ref는 빈 원장이다. */
  branch?: { ref: string; items: Item[]; drifts: Drift[]; files: Overview['files'] };
}
export const designData = (): DesignData => ({
  decisions: decisions(), components: structuredClone(comps), links: structuredClone(links), files: files(), versions: structuredClone(versions),
  items: [...fromTasks(), ...structuredClone(IFACES), ...structuredClone(DATA)], ownership: structuredClone(own), drifts: drifts(), seq: 0,
});
/** 아무 것도 없는 원장(등록 직후·초기화 직후) */
export const emptyDesign = (): DesignData => ({ decisions: [], components: [], links: [], files: [], versions: [], items: [], ownership: [], drifts: [], seq: 0 });

const NOW = () => kst('2026-11-05 20:00');
const isIface = (x: Item) => x.kind !== undefined;
/** 서버는 목록을 item_key 순으로 준다(apps/api/src/design/read.ts snapshotItems). */
const byKey = (a: Item, b: Item) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const view = (x: Item) => ({ key: x.key, name: x.name, description: x.description ?? null, taskKey: x.taskKey, status: 'ok', ...(isIface(x) ? { kind: x.kind } : { store: x.store }) });
const body = (req: Request) => (req.postDataJSON() ?? {}) as Record<string, unknown>;

export function overview(d: DesignData): Overview {
  return {
    version: d.versions[0]?.v ?? null, decisions: d.decisions.length, pending: d.decisions.filter((x) => x.status === 'pending' || x.status === 'change').length,
    drifts: d.drifts.filter((x) => x.status === 'open').length, components: d.components, links: d.links, files: d.files, versions: d.versions,
  };
}

function bump(d: DesignData, by: string, note: string, breaking = false) {
  d.versions.unshift({ v: (d.versions[0]?.v ?? 0) + 1, at: NOW(), by, note, breaking });
}

/** 가짜 API에 설계 원장 요청을 붙인다. calls는 쓰기 요청 기록(본문 포함). */
export function installDesign(api: FakeApi, d: DesignData): { writes: { path: string; body: Record<string, unknown>; key: string | null }[] } {
  const writes: { path: string; body: Record<string, unknown>; key: string | null }[] = [];
  const base = '/api/projects/p1/design';
  /** 요청의 ref에 맞는 원장 부분. main(생략)은 d 그대로, 브랜치는 d.branch, 모르는 브랜치는 빈 것. */
  const at = (req: Request): Pick<DesignData, 'items' | 'drifts' | 'files'> => {
    const ref = new URL(req.url()).searchParams.get('ref');
    if (!ref || ref === 'main') return d;
    return d.branch?.ref === ref ? d.branch : { items: [], drifts: [], files: [] };
  };
  api.on(`GET ${base}`, (route, req) => { const v = at(req); return json(route, 200, { ...overview(d), files: v.files, drifts: v.drifts.filter((x) => x.status === 'open').length }); });
  api.on(`GET ${base}/decisions`, (route) => json(route, 200, { items: d.decisions }));
  api.on(`GET ${base}/interfaces`, (route, req) => {
    const kind = new URL(req.url()).searchParams.get('kind');
    return json(route, 200, { items: at(req).items.filter((x) => isIface(x) && (!kind || x.kind === kind)).sort(byKey).map(view) });
  });
  api.on(`GET ${base}/data`, (route, req) => {
    const store = new URL(req.url()).searchParams.get('store');
    return json(route, 200, { items: at(req).items.filter((x) => !isIface(x) && (!store || x.store === store)).sort(byKey).map(view) });
  });
  api.on(`GET ${base}/ownership`, (route) => json(route, 200, { items: d.ownership }));
  api.on(`GET ${base}/drifts`, (route, req) => json(route, 200, { items: at(req).drifts }));
  const detail = (iface: boolean) => (route: Route, req: Request) => {
    const key = decodeURIComponent(new URL(req.url()).pathname.split('/').pop() ?? '');
    const x = at(req).items.find((i) => i.key === key && isIface(i) === iface);
    if (!x) return json(route, 404, errorBody('NOT_FOUND'));
    const file = d.files.find((f) => f.path === x.path);
    const out = { ...view(x), source: { path: x.path, format: file?.format ?? '', commit: file?.sourceCommit ?? null, status: file?.status ?? 'ok', raw: x.content ? null : 'raw text' }, content: x.content };
    return json(route, 200, out as IfaceDetail | DataDetail);
  };
  // 상세 경로는 key마다 다르므로 가로채기 표에 「접두어」로 붙인다(fake-api는 경로 전체 일치라 아래 route로 직접 단다).
  const openPair = (itemKey: unknown, driftId: unknown) => d.drifts.some((y) => y.id === driftId && y.itemKey === itemKey && y.status === 'open');
  const onDecision = (action: 'approve' | 'reject' | 'change') => (route: Route, req: Request) => {
    const did = new URL(req.url()).pathname.split('/')[4] ?? '';
    const b = body(req);
    writes.push({ path: `${action} ${did}`, body: b, key: req.headers()['idempotency-key'] ?? null });
    const x = d.decisions.find((y) => y.id === did);
    if (!x) return json(route, 404, errorBody('NOT_FOUND'));
    if (b.updatedAt !== x.updatedAt) return json(route, 409, errorBody('VERSION_CONFLICT', { message: '다른 곳에서 먼저 바뀌었습니다.', details: { current: { updatedAt: x.updatedAt } } }));
    if (action === 'change') {
      if (!['approved', 'fixed'].includes(x.status) || x.authority === 'free' || (x.authority === 'lead' && x.level !== 'cond')) return json(route, 409, errorBody('INVALID_TRANSITION'));
      // 연결은 같은 프로젝트의 열린 불일치와 정확한 항목 쌍이어야 한다(apps/api/src/design/service.ts 결정 연결 검사).
      if ((b.itemKey !== undefined || b.driftId !== undefined) && !openPair(b.itemKey, b.driftId)) return json(route, 409, errorBody('INVALID_TRANSITION', { message: '열린 불일치와 같은 항목에만 연결할 수 있습니다.' }));
      x.change = { choice: String(b.choice), reason: String(b.reason), previousStatus: x.status as 'approved' | 'fixed', ...(typeof b.itemKey === 'string' && typeof b.driftId === 'string' ? { itemKey: b.itemKey, driftId: b.driftId } : {}) };
      x.status = 'change';
    } else {
      if (!['pending', 'change'].includes(x.status)) return json(route, 409, errorBody('INVALID_TRANSITION', { message: '승인 또는 변경 대기 중인 결정이 아닙니다.' }));
      const wasChange = x.status === 'change';
      const prev = x.change;
      // 승인할 때도 연결 대상이 아직 열린 불일치인지 다시 본다(제안과 승인 사이에 닫힐 수 있다).
      if (action === 'approve' && prev?.driftId && !openPair(prev.itemKey, prev.driftId)) return json(route, 409, errorBody('INVALID_TRANSITION', { message: '연결한 불일치가 이미 닫혔습니다.' }));
      // 변경 제안의 불일치 연결은 승인할 때 결정에 붙는다(M6-05 fix1).
      if (wasChange && prev) { if (action === 'approve') { x.choice = prev.choice; x.status = 'approved'; if (prev.itemKey && prev.driftId) { x.itemKey = prev.itemKey; x.driftId = prev.driftId; } } else x.status = prev.previousStatus; delete x.change; }
      else x.status = action === 'approve' ? 'approved' : 'rejected';
      bump(d, `팀장 ${action === 'approve' ? '승인' : '반려'} (${x.tdKey})`, `${x.title} — ${action === 'approve' ? `${x.choice}${wasChange ? ' 로 변경' : ' 확정'}` : wasChange ? '변경 반려 — 기존 결정 유지' : '반려'}`, wasChange && action === 'approve');
    }
    d.seq += 1;
    x.updatedAt = new Date(Date.parse(NOW()) + d.seq * 1000).toISOString();
    x.at = x.updatedAt;
    return json(route, 200, x);
  };
  const onResolve = (route: Route, req: Request) => {
    const rid = new URL(req.url()).pathname.split('/')[6] ?? '';
    const b = body(req);
    writes.push({ path: `resolve ${rid}`, body: b, key: req.headers()['idempotency-key'] ?? null });
    const x = d.drifts.find((y) => y.id === rid);
    if (!x) return json(route, 404, errorBody('NOT_FOUND'));
    if (b.updatedAt !== x.updatedAt) return json(route, 409, errorBody('VERSION_CONFLICT', { message: '다른 곳에서 먼저 바뀌었습니다.' }));
    const res = (x.resolution ?? {}) as Record<string, unknown>;
    if (x.status !== 'open' || (res.jobId && !['done', 'failed'].includes(String(res.jobStatus)))) return json(route, 409, errorBody('INVALID_TRANSITION', { message: '이미 처리했거나 계약 반영을 기다리는 불일치입니다.' }));
    d.seq += 1;
    x.updatedAt = new Date(Date.parse(NOW()) + d.seq * 1000).toISOString();
    if (b.how === 'contract') {
      if (x.compat === 'unchecked') return json(route, 409, errorBody('INVALID_TRANSITION', { message: '코드에서 명세를 추출해 대조한 뒤 계약에 반영하세요.' }));
      // 같은 itemKey·같은 driftId를 가리키는 승인 결정만(coord-decisions 2)
      if (x.compat === 'breaking' && !d.decisions.some((y) => y.id === b.decisionId && y.status === 'approved' && y.itemKey === x.itemKey && y.driftId === x.id)) return json(route, 409, errorBody('INVALID_TRANSITION', { message: '호환을 깨는 변경은 승인된 기술 결정이 필요합니다.' }));
      const jobId = `job-${String(d.seq)}`;
      x.resolution = { ...res, how: 'contract', jobId, jobStatus: 'queued', decisionId: b.decisionId ?? null };
      return json(route, 202, { jobId });
    }
    x.status = 'done';
    x.resolution = { ...res, how: 'code', messageId: `msg-${String(d.seq)}` };
    return json(route, 200, x);
  };
  // fake-api는 「METHOD 전체 경로」로 찾으므로 실제 id·key마다 등록한다.
  for (const x of [...d.items, ...(d.branch?.items ?? [])]) api.on(`GET ${base}/${isIface(x) ? 'interfaces' : 'data'}/${encodeURIComponent(x.key)}`, detail(isIface(x)));
  for (const x of d.decisions) for (const a of ['approve', 'reject', 'change'] as const) api.on(`POST /api/design/decisions/${x.id}/${a}`, onDecision(a));
  for (const x of d.drifts) api.on(`POST ${base}/drifts/${x.id}/resolve`, onResolve);
  return { writes };
}
