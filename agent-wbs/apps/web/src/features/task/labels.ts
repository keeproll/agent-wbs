/**
 * Task 상세에서 쓰는 표시 문구·색 클래스·명세/설계 구조.
 * 모두 원본(P = prototype/uiux/Main.dc.html)의 값을 그대로 옮겼다. 줄 번호는 각 상수 위에 적었다.
 * 왜 한 파일에 모으나: 문구가 화면 곳곳에 흩어지면 원본과 어긋나도 찾기 어렵다.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';

export type TaskDetailData = ResponseOf<'getTask'>;
export type TaskSummaryData = ResponseOf<'listTasks'>['tasks'][number];

/** P L2910 */
export const TYPE_LABEL: Record<string, string> = {
  Analysis: '분석', Design: '설계', Implementation: '구현', Configuration: '구성', Test: '테스트', Verification: '검증', Documentation: '문서화', Integration: '통합',
};

/** P L2912–2925 */
export const STATUS: Record<string, { l: string; c: string; tip: string }> = {
  planning: { l: '계획 중', c: 's-plan', tip: 'Lifecycle: 계획 중 — 명세 작성 단계, 실행 요청 불가' },
  approval: { l: '승인 대기', c: 's-appr', tip: 'Planning Approval: 팀장 승인 대기 — 승인 전에는 WBS에 확정되지 않음' },
  ready: { l: '실행 대기', c: 's-ready', tip: 'Execution: 실행 대기 — 선행 조건 충족 시 Runner에 실행 요청 가능' },
  running: { l: '실행 중', c: 's-run', tip: 'Execution: Runner에서 Agent 세션 실행 중' },
  qa: { l: 'QA 진행', c: 's-qa', tip: 'Verification: 검증 Agent QA 진행 중' },
  rework: { l: '재작업 필요', c: 's-rework', tip: 'Verification: QA FAIL — 재작업 시도 필요' },
  verifying: { l: '검증 진행', c: 's-verif', tip: 'Verification: 재검증 진행 중' },
  gate: { l: 'Gate 대기', c: 's-verif', tip: 'Verification PASS — Completion Gate 확인 후 완료 처리' },
  paused: { l: '중단 · 재개 대기', c: 's-rework', tip: 'Execution: Runner 중지 · 사용량 한도 · 오류로 실행이 끊김 — 재개하면 같은 작업을 새 시도로 이어감' },
  done: { l: '완료', c: 's-done', tip: 'Completion Gate 통과 후 완료 처리됨' },
  failed: { l: '실패', c: 's-fail', tip: 'Execution: 실행 실패 — 원인 확인 필요' },
  cancelled: { l: '취소됨', c: 's-plan', tip: '승인된 Change Proposal로 취소됨 — 이력 보존' },
};
export const statusOf = (s: string) => STATUS[s] ?? { l: s, c: 's-plan', tip: '' };

/** P L2927 */
export const PRIORITY = [{ l: '긴급', c: 'p0' }, { l: '높음', c: 'p1' }, { l: '보통', c: 'p2' }, { l: '낮음', c: 'p3' }] as const;
export const priorityOf = (p: number) => PRIORITY[p] ?? { l: String(p), c: 'p2' };

/** P L2928 */
export const VERIF: Record<string, { l: string; c: string }> = {
  none: { l: '미실시', c: 'v-none' }, running: { l: '검증 중', c: 'v-run' }, pass: { l: 'PASS', c: 'v-pass' }, fail: { l: 'FAIL', c: 'v-fail' }, blocked: { l: 'BLOCKED', c: 'v-blk' },
};
/** P L4370 */
export const RESULT_CLASS: Record<string, string> = { PASS: 'v-pass', FAIL: 'v-fail', BLOCKED: 'v-blk' };

/** P L2929 */
export const DEP_LABEL: Record<string, string> = { FS: '완료 → 시작 (FS)', SS: '시작 → 시작 (SS)' };

/** P L2931–2932 메시지 전달 상태 */
export const DELIVERY: Record<string, string> = { Draft: '작성 중', Queued: '전달 대기', Sent: '전달 완료', Acknowledged: '수신 확인', Failed: '전달 실패', Cancelled: '전송 취소' };
export const DELIVERY_CLASS: Record<string, string> = { Draft: 'd-c', Queued: 'd-q', Sent: 'd-s', Acknowledged: 'd-a', Failed: 'd-f', Cancelled: 'd-c' };

/**
 * 시도 상태. 원본은 한글 상태(완료·실패·실행 중·중단, P L2930)를 썼고 계약은 영문 값이다.
 * 같은 뜻끼리 짝지었다.
 */
export const ATTEMPT_STATUS: Record<string, { l: string; c: string }> = {
  completed: { l: '완료', c: 's-done' }, failed: { l: '실패', c: 's-fail' }, running: { l: '실행 중', c: 's-run' }, interrupted: { l: '중단', c: 's-rework' },
};
/** 시도 종류(계약 AttemptKind) — 원본 att.kind 문구 */
export const ATTEMPT_KIND: Record<string, string> = { dev: '개발', qa: 'QA', rework: '재작업', reverify: '재검증' };

/** P L3646–3647 */
export const agCls = (a: string | null) => (a === 'Claude' ? 'ag-claude' : 'ag-codex');
export const agInit = (a: string | null) => (a === 'Claude' ? 'Cl' : 'Cx');

/** Completion Gate 5조건 이름(P L3693–3697) */
export const GATE_LABEL: Record<string, string> = {
  checklist: '필수 Checklist 완료', outputs: '필수 산출물 존재', verification: '필요한 Verification 통과', defects: '미해결 차단 결함 없음', approval: '필요한 승인 완료',
};
export const GATE_ORDER = ['checklist', 'outputs', 'verification', 'defects', 'approval'] as const;

/** 실행 흐름 단계(P L5942–5947) */
export const FLOW_ORDER = ['dev', 'qa', 'rework', 'reverify', 'gate', 'done'] as const;

/** `백틱`으로 감싼 부분은 코드로 보인다(P L5189 segs). */
export function segs(text: string): { t: string; code: boolean }[] {
  return String(text).split('`').map((t, i) => ({ t, code: i % 2 === 1 })).filter((x) => x.t !== '');
}

/** 여러 줄 입력을 줄 목록으로(원본 lines(): 빈 줄 제외, 앞뒤 공백 제거) */
export const toLines = (text: string): string[] => text.split('\n').map((x) => x.trim()).filter(Boolean);

/* ---------- 작업 명세 6그룹 13섹션(P L2934–2941) ---------- */
export type SpecKey = 'req' | 'work' | 'steps' | 'inputs' | 'outputs' | 'files' | 'constraints' | 'errors' | 'docs' | 'verify';
export type SpecSectionKey = SpecKey | '__out' | 'ac' | '__outputs';
export interface SpecSection { key: SpecSectionKey; title: string; mode?: 'ol' | 'mono' | 'tbl:ac' | 'tbl:outputs' }
export const SPEC_GROUPS: { label: string; cls: string; desc: string; keys: SpecSection[] }[] = [
  { label: '구현할 내용', cls: 'g-do', desc: '무엇을 만들고 어떤 순서로 진행하는가', keys: [{ key: 'req', title: '상세 요구사항' }, { key: 'work', title: '수행 작업' }, { key: 'steps', title: '구현 절차', mode: 'ol' }] },
  { label: '입력 · 출력', cls: 'g-io', desc: '작업 근거 자료와 결과물', keys: [{ key: 'inputs', title: '입력 자료' }, { key: 'outputs', title: '예상 출력' }, { key: 'files', title: '관련 파일/모듈', mode: 'mono' }] },
  { label: '구현 방법 · 제약', cls: 'g-con', desc: '지켜야 할 기술적 제약과 예외 처리', keys: [{ key: 'constraints', title: '기술적 제약' }, { key: 'errors', title: '예외 및 오류 처리' }] },
  { label: '구현하지 않을 내용', cls: 'g-not', desc: '개요의 제외 범위와 같은 데이터', keys: [{ key: '__out', title: '제외 범위' }] },
  { label: '완료 판단', cls: 'g-done', desc: 'Acceptance Criteria · 산출물 및 검증 조건 · 검증 방법', keys: [{ key: 'ac', title: 'Acceptance Criteria', mode: 'tbl:ac' }, { key: '__outputs', title: '산출물 및 검증 조건', mode: 'tbl:outputs' }, { key: 'verify', title: '검증 방법' }] },
  { label: '참고', cls: 'g-ref', desc: '관련 문서', keys: [{ key: 'docs', title: '관련 문서', mode: 'mono' }] },
];

/* ---------- 표 열 정의(P L2953–2965 COLSETS) ---------- */
export interface Col {
  k: string; l: string; w: string;
  mono?: boolean; req?: boolean; b?: boolean; ph?: string;
  t?: 'check' | 'sel'; sel?: 'idx' | 'out' | 'state'; on?: string; off?: string; dv?: string | boolean; mask?: string;
}
export const SELECT_OPTIONS: Record<'idx' | 'out' | 'state', string[]> = {
  idx: ['BTREE', 'UNIQUE', 'GIN', 'HASH'],
  out: ['코드', '문서', 'Migration', '테스트', '설정'],
  state: ['Loading', 'Empty', 'Error', 'Success', 'Disabled'],
};
export const COLSETS: Record<string, Col[]> = {
  db_columns: [{ k: 'name', l: '컬럼명', mono: true, req: true, w: '160px', b: true }, { k: 'type', l: '데이터 타입', mono: true, req: true, w: '170px' }, { k: 'nullable', l: 'Null', t: 'check', w: '56px', on: 'YES', off: 'NO' }, { k: 'pk', l: 'PK', t: 'check', w: '48px', on: 'PK', off: '' }, { k: 'fk', l: 'FK 참조', mono: true, w: '170px', ph: 'table.column' }, { k: 'unique', l: 'Unique', t: 'check', w: '64px', on: 'UNIQUE', off: '' }, { k: 'def', l: 'Default', mono: true, w: '160px' }, { k: 'desc', l: '설명', w: '1fr' }],
  db_indexes: [{ k: 'name', l: 'Index 이름', mono: true, req: true, w: '220px', b: true }, { k: 'cols', l: '대상 컬럼 (쉼표 구분)', mono: true, req: true, w: '1fr' }, { k: 'kind', l: '종류', t: 'sel', sel: 'idx', w: '120px', dv: 'BTREE' }],
  api_errors: [{ k: 'code', l: '오류 코드', mono: true, req: true, w: '220px', b: true }, { k: 'http', l: 'HTTP', mono: true, req: true, w: '80px' }, { k: 'cond', l: '발생 조건', w: '1fr' }],
  fe_screens: [{ k: 'name', l: '화면', req: true, w: '160px', b: true }, { k: 'route', l: 'Route', mono: true, w: '240px' }, { k: 'purpose', l: '화면 목적', w: '1fr' }],
  fe_components: [{ k: 'name', l: '컴포넌트', mono: true, req: true, w: '170px', b: true }, { k: 'path', l: '경로', mono: true, w: '280px' }, { k: 'role', l: '책임', w: '1fr' }],
  fe_inputs: [{ k: 'field', l: '입력값', req: true, w: '160px', b: true }, { k: 'rule', l: '검증 규칙', w: '1fr' }, { k: 'req', l: '필수', t: 'check', w: '56px', on: '필수', off: '선택' }],
  fe_states: [{ k: 'state', l: '상태', t: 'sel', sel: 'state', req: true, w: '120px', dv: 'Loading', b: true }, { k: 'display', l: '표시 방식', req: true, w: '1fr' }],
  ops_files: [{ k: 'path', l: '파일 경로', mono: true, req: true, w: '280px', b: true }, { k: 'role', l: '역할', w: '1fr' }],
  ops_env: [{ k: 'name', l: '변수명', mono: true, req: true, w: '200px', b: true }, { k: 'example', l: '예시 값', mono: true, w: '300px', mask: 'secret' }, { k: 'secret', l: '비밀', t: 'check', w: '56px', on: 'Secret', off: '' }, { k: 'desc', l: '설명', w: '1fr' }],
  ops_services: [{ k: 'name', l: '서비스', req: true, w: '140px', b: true }, { k: 'image', l: '이미지', mono: true, w: '220px' }, { k: 'port', l: '포트', mono: true, w: '80px' }, { k: 'note', l: '비고', w: '1fr' }],
  ac: [{ k: 'given', l: 'Given (전제)', req: true, w: '1fr' }, { k: 'when', l: 'When (행동)', req: true, w: '1fr' }, { k: 'then', l: 'Then (기대 결과)', req: true, w: '1fr' }, { k: 'method', l: '검증 방법', w: '200px' }],
  outputs: [{ k: 'name', l: '산출물 (경로·이름)', mono: true, req: true, w: '1fr', b: true }, { k: 'kind', l: '유형', t: 'sel', sel: 'out', w: '110px', dv: '코드' }, { k: 'required', l: '필수', t: 'check', w: '56px', on: '필수', off: '선택', dv: true }, { k: 'verify', l: '검증 조건', w: '1fr' }, { k: 'delivered', l: '제출', t: 'check', w: '64px', on: '제출됨', off: '미제출' }],
};

/* ---------- 기술 설계 스키마(P L2966–2983) ---------- */
export type DesignKind = 'DB' | 'API' | 'FE' | 'DevOps';
export interface Block { k: string; l: string; t: 'table' | 'lines' | 'code'; cols?: string; addL?: string; hint?: string }
export interface EntField { k: string; l: string; req?: boolean; mono?: boolean; ph?: string; opts?: string[] }
export interface DesignSchema {
  label: string; desc: string;
  ent: { label: string; addL: string; fields: EntField[]; blocks: Block[] } | null;
  blocks: Block[];
}
export const DESIGN: Record<DesignKind, DesignSchema> = {
  DB: {
    label: 'DB 설계', desc: '테이블 · 컬럼 · 제약조건 · Migration',
    ent: {
      label: '테이블', addL: '테이블 추가',
      fields: [{ k: 'name', l: '테이블명', req: true, mono: true, ph: 'snake_case' }, { k: 'change', l: '구분', opts: ['신규', '변경', '삭제'], req: true }, { k: 'desc', l: '테이블 설명' }],
      blocks: [
        { k: 'columns', l: '컬럼 정의', t: 'table', cols: 'db_columns', addL: '컬럼 추가', hint: 'FK 참조는 table.column 형식 · 다른 Task에서 정의한 테이블도 참조할 수 있습니다' },
        { k: 'indexes', l: 'Index', t: 'table', cols: 'db_indexes', addL: 'Index 추가', hint: '대상 컬럼은 이 테이블의 컬럼명을 쉼표로 구분' },
      ],
    },
    blocks: [{ k: 'migration', l: 'Migration 요구사항', t: 'lines' }, { k: 'seed', l: 'Seed 데이터', t: 'lines' }, { k: 'integrity', l: '데이터 무결성 조건', t: 'lines' }],
  },
  API: {
    label: 'BE / API 설계', desc: 'Endpoint · Request/Response · Validation · 오류 응답 · 계층 책임',
    ent: {
      label: 'Endpoint', addL: 'Endpoint 추가',
      fields: [{ k: 'method', l: 'HTTP Method', opts: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], req: true }, { k: 'path', l: 'Path', req: true, mono: true, ph: '/api/...' }, { k: 'desc', l: '설명' }, { k: 'auth', l: '인증 · 권한', opts: ['팀장 세션', 'Runner 토큰', '없음'] }],
      blocks: [{ k: 'request', l: 'Request Schema', t: 'code' }, { k: 'response', l: 'Response Schema', t: 'code' }, { k: 'validation', l: 'Validation', t: 'lines' }, { k: 'errors', l: 'Error Response', t: 'table', cols: 'api_errors', addL: '오류 추가' }, { k: 'tables', l: '관련 DB 테이블', t: 'lines' }],
    },
    blocks: [{ k: 'resp', l: 'Service / Repository 책임', t: 'lines' }],
  },
  FE: {
    label: 'FE 설계', desc: '화면 · 컴포넌트 · Interaction · 입력 검증 · API 연결 · 상태', ent: null,
    blocks: [{ k: 'screens', l: '대상 화면', t: 'table', cols: 'fe_screens', addL: '화면 추가' }, { k: 'components', l: '컴포넌트', t: 'table', cols: 'fe_components', addL: '컴포넌트 추가' }, { k: 'interactions', l: '사용자 Interaction', t: 'lines' }, { k: 'inputs', l: '입력값 · 검증', t: 'table', cols: 'fe_inputs', addL: '입력값 추가' }, { k: 'apis', l: 'API 연결', t: 'lines' }, { k: 'states', l: 'Loading / Empty / Error 상태', t: 'table', cols: 'fe_states', addL: '상태 추가' }, { k: 'navigation', l: '화면 이동 · 결과 표시', t: 'lines' }],
  },
  DevOps: {
    label: 'DevOps 설계', desc: '대상 환경 · 구성 파일 · 환경 변수 · 명령 · Health Check · 배포/복구', ent: null,
    blocks: [{ k: 'targets', l: '대상 환경', t: 'lines' }, { k: 'files', l: '구성 파일', t: 'table', cols: 'ops_files', addL: '파일 추가' }, { k: 'env', l: '환경 변수', t: 'table', cols: 'ops_env', addL: '변수 추가', hint: '변수명은 대문자 · 숫자 · _ · 비밀 값은 읽기 화면에서 가려집니다' }, { k: 'commands', l: '실행 명령', t: 'code' }, { k: 'services', l: '의존 서비스', t: 'table', cols: 'ops_services', addL: '서비스 추가' }, { k: 'health', l: 'Health Check', t: 'lines' }, { k: 'deploy', l: '배포 · 복구 조건', t: 'lines' }],
  },
};
export const DESIGN_KINDS: DesignKind[] = ['DB', 'API', 'FE', 'DevOps'];
/** P L2984 */
export const DOMAIN_TO_DESIGN: Record<string, DesignKind> = { DB: 'DB', BE: 'API', API: 'API', FE: 'FE', DevOps: 'DevOps' };
/** 작업 명세 표 편집기(P L2979–2982 SPEC_TBL) */
export const SPEC_TBL: Record<'ac' | 'outputs', Block> = {
  ac: { k: 'ac', l: 'Acceptance Criteria', t: 'table', cols: 'ac', addL: '기준 추가', hint: 'Given(전제) · When(행동) · Then(기대 결과) 필수 · 검증 방법은 검증 Agent가 확인할 수단' },
  outputs: { k: 'outputs', l: '산출물 및 검증 조건', t: 'table', cols: 'outputs', addL: '산출물 추가', hint: '필수 산출물이 모두 제출되어야 Completion Gate를 통과합니다. 제출 여부는 Phase C부터 실행 결과로 갱신됩니다' },
};

/** 읽기 표의 열 폭(P L5432 readTable) */
export const readGrid = (cols: Col[]) => cols.map((c) => (c.w === '1fr' ? 'minmax(180px,1fr)' : `minmax(${c.w},max-content)`)).join(' ');
/** 편집 표의 열 폭(P L5444 editTable). 마지막 44px는 행 삭제 버튼 칸 */
export const editGrid = (cols: Col[]) => `${cols.map((c) => (c.w === '1fr' ? 'minmax(160px,1fr)' : c.w)).join(' ')} 44px`;

/** 읽기 표 칸 값(P L5436–5440) */
export function cellText(c: Col, row: Record<string, unknown>): string {
  const v = row[c.k];
  if (c.t === 'check') return v ? (c.on ?? '✓') : (c.off ?? '—');
  if (c.mask && row[c.mask]) return '••••••';
  return v === '' || v === null || v === undefined ? '—' : String(v as string);
}
