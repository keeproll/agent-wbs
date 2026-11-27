/**
 * 설정 화면의 고정 문구·선택지. 원본(P) 값 그대로이며 줄 번호를 남긴다.
 * 왜 한곳에 모으나: 같은 문구를 여러 탭·시험이 함께 쓰고, 원본과 비교할 때 한 파일만 보면 된다.
 */

/** 설정 6탭(P L6657 TB). key는 주소 `/settings/<key>`(G§4.9). */
export const SETTINGS_TABS = [
  { key: 'runner', label: 'Runner · 실행 환경', desc: 'GitHub 연결 · Runner 연결 · 준비 상태 · 가용 용량 · 동시 실행 한도' },
  { key: 'agent', label: 'Agent', desc: '역할 · 기본 Workflow · 모델 · Effort 정책 · 하위 Agent' },
  { key: 'plan', label: '일정 · Task', desc: 'Task 분할 기준 · 일정 재조정 정책 · 작업 불가일 · 진행률 산정' },
  { key: 'report', label: '보고서 · 메일', desc: '보고서 메일 수신자 · 일간 / 주간 구독 · SMTP · 발송 기록' },
  { key: 'notify', label: '알림', desc: 'Telegram 연결 · 수신 대상 · 알림 규칙 · 메시지 미리보기 · 전송 이력 · 접속 주소' },
  // 제품은 정합성 점검만 남긴다(G L346, UAT-POLICY-05). 그래서 탭 이름에서 「Prototype」을 뺐다.
  { key: 'system', label: '점검', desc: '데이터 정합성 점검' },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]['key'];
export const isSettingsTab = (value: string | undefined): value is SettingsTab => SETTINGS_TABS.some((t) => t.key === value);

/** GitHub 권한 4종(P L3552 GH_SCOPES) */
export const GH_SCOPES = [
  { key: 'contents', label: 'Contents', level: '읽기 · 쓰기', use: '입력 읽기 · Task 브랜치 push' },
  { key: 'pulls', label: 'Pull requests', level: '쓰기', use: 'Task PR 생성 · 병합' },
  { key: 'statuses', label: 'Commit statuses', level: '쓰기', use: 'Runner 검사 결과를 PR에 보고' },
  { key: 'metadata', label: 'Metadata', level: '읽기', use: '저장소 정보' },
] as const;

/** 권한 3상태(contracts GithubPermission). 원본은 있음/없음 두 가지였다(MM-12). */
export const GH_PERMISSION: Record<string, { label: string; cls: string }> = {
  verified: { label: '있음', cls: 'vf v-pass' },
  unverified: { label: '미확인', cls: 'vf v-blk' },
  missing: { label: '없음', cls: 'vf v-fail' },
};

/** 준비 상태 항목 이름(P L3502 READY_MOCK의 l). 계약 ReadinessKey 순서. */
export const READINESS_LABEL: Record<string, string> = {
  claude: 'Claude Code CLI',
  codex: 'Codex CLI',
  git: 'git',
  node: 'Node.js',
  pnpm: 'pnpm',
  pg: 'PostgreSQL 연결',
  repo: '작업 저장소 접근',
  disk: 'worktree 디스크 여유',
  subs: '하위 Agent 정의 동기화',
  obs: 'CLI 버전 — 하위 Agent 관측 검증',
  gh: 'GitHub 인증',
  lfs: 'git LFS',
  reports: '보고서 저장 공간',
  font: '화면 비교 고정 글꼴',
  render: '화면 비교 렌더러 네트워크 차단',
};
/** P L6740 rd */
export const READINESS_STATUS: Record<string, { label: string; cls: string }> = {
  ok: { label: '정상', cls: 'sc sc-ok' },
  warn: { label: '주의', cls: 'sc sc-warn' },
  fail: { label: '문제', cls: 'sc sc-bad' },
};

/** 관측 등급(P L3500 OBS_GRADE, 계약 ObservationGrade) */
export const OBS_GRADE: Record<string, { label: string; cls: string }> = {
  verified: { label: '검증됨', cls: 'vf v-pass' },
  partial: { label: '일부 관측', cls: 'vf v-blk' },
  unverified: { label: '미검증', cls: 'vf v-none' },
};

/** 중단 사유(계약 EndReason). P는 사유 원문을 그대로 보였다. */
export const END_REASON: Record<string, string> = {
  reboot: '재부팅', power_off: 'PC 꺼짐', error: '오류', manual: '수동 중지', unknown: 'heartbeat 끊김',
};

/** 동시 실행을 제한하는 요인(계약 factor) */
export const FACTOR_LABEL: Record<string, string> = {
  cap: '팀장 상한', runner_limit: 'Runner 조절 한도', parallel_tasks: '병렬 가능한 Task 수',
};

/** Effort 이름(P L3450 EFF) */
export const EFFORT_LABEL: Record<string, string> = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };

/** Task 분할 10규칙(P L3509 SPLIT_RULES) */
export const SPLIT_RULES = [
  { key: 'one', label: '목적이 하나', desc: '제목이 「동사 + 대상 하나」로 표현됨', how: 'auto' },
  { key: 'domain', label: '주 기술 영역이 하나', desc: 'DB · BE · FE · DevOps 중 하나만 변경', how: 'auto' },
  { key: 'size', label: '크기 상한 이내', desc: '예상 실행 시간 · 바뀌는 파일 수 상한 이내 (상한을 꽉 채울 필요는 없음)', how: 'auto' },
  { key: 'verify', label: '혼자 검증 가능', desc: '자기 Acceptance Criteria · 검증 명령 · 테스트로 PASS / FAIL 판정 (없는 다른 Task는 계약 기반 Mock으로 대체)', how: 'auto' },
  { key: 'revert', label: '혼자 되돌릴 수 있음', desc: '커밋 하나로 되돌려도 다른 Task가 깨지지 않음', how: 'judge' },
  { key: 'cg', label: '충돌 묶음이 하나', desc: '같은 모듈 · 파일 범위만 변경', how: 'auto' },
  { key: 'contract', label: '공유 계약 변경은 따로', desc: '공통 타입 · DB 스키마 · API 계약 변경은 그것만 하는 선행 Task로', how: 'judge' },
  { key: 'irrev', label: '되돌리기 어려운 변경은 따로', desc: 'Migration · 데이터 이전은 코드와 분리', how: 'auto' },
  { key: 'refactor', label: '정리와 기능 변경은 따로', desc: '리팩터링은 선행 Task로 분리', how: 'judge' },
  { key: 'unknown', label: '불확실하면 조사부터', desc: '추정 신뢰도 하 · 낙관 대비 비관 2.5배 초과면 분석 Task 선행', how: 'auto' },
] as const;

/** 진행률 가중치(P L3397 STAGE_PCT, owner Q-03)와 상태 이름·색(P L2909 LBL.status). 표 순서는 P L6779. */
export const STAGES = [
  { key: 'planning', label: '계획 중', cls: 's-plan', pct: 0 },
  { key: 'approval', label: '승인 대기', cls: 's-appr', pct: 0 },
  { key: 'ready', label: '실행 대기', cls: 's-ready', pct: 0 },
  { key: 'running', label: '실행 중', cls: 's-run', pct: 35 },
  { key: 'failed', label: '실패', cls: 's-fail', pct: 20 },
  { key: 'rework', label: '재작업 필요', cls: 's-rework', pct: 50 },
  { key: 'qa', label: 'QA 진행', cls: 's-qa', pct: 65 },
  { key: 'verifying', label: '검증 진행', cls: 's-verif', pct: 80 },
  { key: 'gate', label: 'Gate 대기', cls: 's-verif', pct: 90 },
  { key: 'done', label: '완료', cls: 's-done', pct: 100 },
] as const;

/** 선택지(P L6694·6698·6764~6771). 기본값: 낮춤 기준 20%·가정 가동률 60%·재조정 임계값 1일(owner 2026-11-26). */
export const OPTIONS = {
  lowPct: [10, 20, 30],
  thresholdDays: [1, 2, 3, 5],
  assumeRate: [0.4, 0.6, 0.8],
  maxHours: [2, 3, 4, 6],
  minHours: [0.5, 1],
  maxFiles: [5, 8, 12],
  memReserveGB: [2, 4, 6],
  notifyAt: [[1, '1회째'], [2, '2회째'], [3, '3회째'], [0, '알리지 않음']] as const,
  budgetDev: [1, 2, 3, 4],
  budgetQa: [1, 2, 3, 4, 5],
} as const;

/** 시간 표시(P L3415 fmtH): 0.5 → 0.5h, 4 → 4h */
export const hoursLabel = (hours: number): string => `${String(Math.round(hours * 10) / 10)}h`;

/** 값 목록에 현재 값이 없으면 넣고 정렬한다(P L6744 uniq). 서버 값이 선택지 밖이어도 보이게 한다. */
export const withValue = (list: readonly number[], value: number): number[] =>
  (list.includes(value) ? [...list] : [...list, value]).sort((a, b) => a - b);

/** Agent 표시 기호(P agInit·agCls) */
export const agentMark = (agent: string) => ({ cls: agent === 'Claude' ? 'ag-claude' : 'ag-codex', init: agent === 'Claude' ? 'Cl' : 'Cx' });
