/**
 * 프로젝트 화면(UI-02·02A~E, MOD-05)이 쓰는 고정 문구·표. 원본 Main.dc.html의 값을 그대로 옮겼다(출처 P 줄 번호).
 * 왜 한곳에 모으나: 문구가 원본과 다르면 시각 비교·UAT에서 바로 드러나야 하고, 화면 여러 곳이 같은 문구를 쓴다.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';

export type ProjectState = ResponseOf<'getProject'>;
export type BootProject = Extract<ProjectState, { bootstrap: unknown }>;
export type RegisteredProject = Extract<ProjectState, { repo: unknown }>;
export type Decision = BootProject['bootstrap']['decisions'][number];
export type StepStatus = 'wait' | 'run' | 'done' | 'fail';

/** 저장소 디렉토리 규칙(P L3550 REPO_LAYOUT) */
export const REPO_LAYOUT: readonly (readonly [string, string, string])[] = [
  ['prototype/uiux/', '입력 — 프로토타입 (압축 해제 상태 · HTML · JS · CSS)', '필수 · Agent 수정 금지'],
  ['prototype/docs/', '입력 — 설계 의도 · 구현 가이드 · 디자인 정의 등 구현에 필요한 md (여러 개)', '필수 · Agent 수정 금지'],
  ['src/', '개발 소스 — Agent 작업 영역 · 빌드 기준', '없으면 첫 커밋에서 생성'],
  ['contracts/', '계약 — API · 이벤트 · DB 스키마 · 마이그레이션 · 캐시 키', '없으면 계약 설계 Task가 생성'],
  ['.agentwbs/', 'Agent WBS 설정 — 빌드 파이프라인 정의', '없으면 첫 커밋에서 생성 · 변경 시 팀장 승인'],
];

/** 초기 분석 9단계(P L4488 BOOT_STEPS). 서버는 key만 보내고 이름·설명은 화면이 붙인다. */
export const BOOT_STEPS: Record<string, readonly [string, string]> = {
  check: ['GitHub 접근 · 커밋 고정', 'main 최신 커밋을 입력 v1로 고정하고 필수 구조(prototype/ (uiux · docs)) 확인'],
  unzip: ['입력 자료 checkout', 'prototype/ (uiux · docs) 을 읽기 전용 폴더로 받음 — 안의 스크립트 · 설치 명령은 실행하지 않음'],
  repo: ['작업 준비 · 기준 커밋 기록', 'Runner 로컬 clone · src/ · contracts/ · .agentwbs/ 없으면 첫 커밋으로 생성 · 초기화 기준 커밋 기록'],
  codex: ['Codex 독립 분석', '화면 · 기능 단위로 나눠 분석, Task 후보 · 선행 관계 · 작업량 추정'],
  claude: ['Claude 독립 분석', '설계 문서(md)의 의도 · 확정 사항을 반영해 독립 분석'],
  cross: ['교차 검토 · 이견 조정', '두 분석의 일치 · 이견 정리, 합의안 작성'],
  tech: ['기술 결정 확정', '팀장 지정 제약 + Agent 제안(저장소 · 통신 방식 · 메시지 형식)을 팀장이 별도로 승인 — 확정된 결정 위에서 WBS 초안 작성'],
  draft: ['WBS 초안 작성', 'Phase · Work Package · Task 명세 · 체크리스트 · 실행 등급 · 충돌 묶음'],
  approve: ['팀장 승인', '초기 WBS는 팀장이 한 번 승인 — 승인하면 기준 일정 v1 생성'],
};

/** 차이 분석 5단계(P L4490 IN_STEPS) */
export const INPUT_STEPS: Record<string, readonly [string, string]> = {
  check: ['커밋 고정 · 입력 경로 확인', '팀장이 고른 커밋을 새 입력 버전으로 고정 — prototype/ (uiux · docs) 변경만 대상'],
  unzip: ['변경 파일 checkout', '읽기 전용 · 스크립트 실행 안 함'],
  diff: ['이전 버전 커밋과 비교', 'git diff — 바뀐 화면 · 기능 · 문서 문단 추출'],
  impact: ['Planning — Codex · Claude 영향 분석', '기존 Task 수정 · 재작업 후보 · 신규 Task · 취소 후보'],
  cp: ['Change Proposal 작성', 'Task 추가 · 수정 · 재작업 · 취소 → 팀장 승인(또는 자동 반영 정책) → 일정 재조정'],
};

/** 단계 상태 표시(P setupVM stC·stL) */
export const STEP_CHIP: Record<StepStatus, readonly [string, string]> = {
  wait: ['sc sc-none', '대기'],
  run: ['sc sc-warn', '진행 중'],
  done: ['sc sc-ok', '완료'],
  fail: ['sc sc-bad', '실패'],
};

/** 기술 결정 권한·수준·상태 표시(P L3556–3558) */
export const TECH_AUTH: Record<string, readonly [string, string]> = {
  lead: ['팀장 지정', 'sc sc-ok'],
  agent: ['Agent 제안 → 팀장 승인', 'sc sc-none'],
  free: ['Agent 재량 (기록)', 'sc sc-none'],
};
export const TECH_LV: Record<string, string> = { must: '필수', cond: '조건부 선호', ban: '금지' };
export const TECH_ST: Record<string, readonly [string, string]> = {
  fixed: ['확정', 'vf v-pass'],
  approved: ['승인됨', 'vf v-pass'],
  pending: ['승인 대기', 'vf v-run'],
  rejected: ['반려', 'vf v-none'],
  noted: ['기록', 'vf v-none'],
  change: ['변경 제안 — 승인 대기', 'vf v-run'],
};

export const LEVELS = [['must', '필수'], ['cond', '조건부 선호'], ['ban', '금지']] as const;
export type Level = (typeof LEVELS)[number][0];

/** 입력 변경 파일의 종류 표시(P inputVM chC). 서버는 added·modified·deleted를 보낸다. */
export const CHANGE_CHIP: Record<string, readonly [string, string]> = {
  modified: ['sc sc-warn', '수정'],
  added: ['sc sc-ok', '추가'],
  deleted: ['sc sc-bad', '삭제'],
};

/**
 * 입력 파일의 영역. 원본은 옛 정규식 `/^docs\//`로 나눠 설계 문서를 프로토타입으로 잘못 분류했다(MM-04).
 * 제품은 현재 규칙대로 prototype/docs/ 아래면 설계 문서, 그 밖의 prototype/ 아래는 프로토타입이다(G§4.2).
 */
export const inputArea = (path: string): '설계 문서' | '프로토타입' => (path.startsWith('prototype/docs/') ? '설계 문서' : '프로토타입');

/** 「예시 값 채우기」(P setupVM reg.sample). 시나리오 29·30의 기술 제약 4개 */
export const SAMPLE = {
  name: 'Verum-SDN Agent WBS — Self Development',
  url: 'https://github.com/verum-sdn/agent-wbs',
  target: '2027-02-26',
  instr: 'prototype/uiux/ 와 prototype/docs/ 설계 문서를 분석하고 Task 식별을 시작하자.',
  tech: [
    { name: 'PostgreSQL 16', level: 'must', cond: '' },
    { name: 'Redis 7', level: 'must', cond: '' },
    { name: 'QuestDB', level: 'cond', cond: '시계열 데이터(시간 순 대량 쓰기 · 구간 집계 · 보관 기간)가 있으면 사용' },
    { name: '외부 클라우드 관리형 서비스', level: 'ban', cond: '' },
  ] as { name: string; level: Level; cond: string }[],
};

/** 짧은 커밋 표시(원본은 7자리) */
export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '—');

/** 시간 표시(시간 단위 숫자 → 「3.5h」). 원본 fmtH는 h 단위다. */
export const fmtH = (hours: number): string => `${String(Math.round(hours * 10) / 10)}h`;

/** Task 유형 이름(P L2910 LBL.type) */
export const TYPE_LABEL: Record<string, string> = {
  Analysis: '분석', Design: '설계', Implementation: '구현', Configuration: '구성', Test: '테스트', Verification: '검증', Documentation: '문서화', Integration: '통합',
};
