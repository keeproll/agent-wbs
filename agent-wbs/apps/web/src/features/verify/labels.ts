/**
 * M3-07 세 화면(대시보드·검증·이력)이 함께 쓰는 표시 이름·색 클래스·이동 주소.
 * 값은 원본 프로토타입(P L2909–2932, L4370, L4455, L3646–3647)을 그대로 옮겼다.
 * 서버 값(영문 키)을 화면 글자·원본 CSS 클래스로 바꾸는 표다. 값 자체는 바꾸지 않는다.
 */

/** 작업 유형(P LBL.type L2910) */
export const WORK_TYPE_LABEL: Record<string, string> = {
  Analysis: '분석', Design: '설계', Implementation: '구현', Configuration: '구성',
  Test: '테스트', Verification: '검증', Documentation: '문서화', Integration: '통합',
};

/** 기술 영역(P LBL.domain L2911) */
export const DOMAIN_LABEL: Record<string, string> = {
  FE: 'Frontend', BE: 'Backend', DB: 'Database', DevOps: '개발·배포',
  API: 'API·연동', QA: '품질 검증', Architecture: '시스템 구조', Common: '공통',
};

/** Task 상태 이름·색(P LBL.status L2912–2926) */
export const STATUS_LABEL: Record<string, { l: string; c: string }> = {
  planning: { l: '계획 중', c: 's-plan' },
  approval: { l: '승인 대기', c: 's-appr' },
  ready: { l: '실행 대기', c: 's-ready' },
  running: { l: '실행 중', c: 's-run' },
  qa: { l: 'QA 진행', c: 's-qa' },
  rework: { l: '재작업 필요', c: 's-rework' },
  verifying: { l: '검증 진행', c: 's-verif' },
  gate: { l: 'Gate 대기', c: 's-verif' },
  paused: { l: '중단 · 재개 대기', c: 's-rework' },
  done: { l: '완료', c: 's-done' },
  failed: { l: '실패', c: 's-fail' },
  cancelled: { l: '취소됨', c: 's-plan' },
};
export const statusLabel = (status: string) => STATUS_LABEL[status] ?? { l: status, c: 's-plan' };

/** 판정 색(P VC L4370). 모르는 값은 v-none */
export const verdictClass = (result: string | null | undefined): string =>
  `vf ${result === 'PASS' ? 'v-pass' : result === 'FAIL' ? 'v-fail' : result === 'BLOCKED' ? 'v-blk' : 'v-none'}`;

/** 실행 시도 종류. 원본은 한글 값(개발·QA·재작업·재검증)을 그대로 저장했다. 서버는 영문 키다. */
export const ATTEMPT_KIND_LABEL: Record<string, string> = { dev: '개발', qa: 'QA', rework: '재작업', reverify: '재검증' };
/** 실행 시도 상태(P LBL.att L2930). 서버 키 → 원본 글자·색 */
export const ATTEMPT_STATUS: Record<string, { l: string; c: string }> = {
  completed: { l: '완료', c: 's-done' },
  failed: { l: '실패', c: 's-fail' },
  running: { l: '실행 중', c: 's-run' },
  interrupted: { l: '중단', c: 's-rework' },
};

/** CP 상태(P CPST L4455). held(보류)는 원본에 없어 제품이 더했다(M3-05와 같은 이름). */
export const CP_STATUS: Record<string, { l: string; c: string }> = {
  draft: { l: '작성 중', c: 'c-draft' }, review: { l: '승인 대기', c: 'c-review' }, changes: { l: '수정 요청', c: 'c-changes' },
  approved: { l: '승인됨 · 반영 대기', c: 'c-approved' }, rejected: { l: '반려', c: 'c-rejected' }, applied: { l: 'WBS 반영 완료', c: 'c-applied' },
  held: { l: '보류', c: 'c-changes' },
};

/** Agent 표시(P agCls·agInit L3646–3647) */
export const agentClass = (agent: string) => (agent === 'Claude' ? 'ag-claude' : 'ag-codex');
export const agentInitial = (agent: string) => (agent === 'Claude' ? 'Cl' : 'Cx');

/** Effort 이름(P EFF L3450) */
export const EFFORT_LABEL: Record<string, string> = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };

/** Completion Gate 5조건 순서와 이름(G§5.5, P Sel.gate). 서버 키 → 원본 열 이름 */
export const GATE_KEYS = ['checklist', 'outputs', 'verification', 'defects', 'approval'] as const;
export const GATE_LABEL: Record<string, string> = {
  checklist: 'Checklist', outputs: '산출물', verification: 'Verification', defects: '차단 결함', approval: '승인',
};
/** 대시보드 Gate 패널의 짧은 이름(원본은 조건 문구 끝의 「완료·존재·통과·없음」을 떼어 썼다, P L6292) */
export const GATE_SHORT: Record<string, string> = {
  checklist: '필수 체크리스트', outputs: '필수 산출물', verification: '최신 Verification', defects: '차단 결함', approval: '팀장 승인',
};

/** 「11-05」처럼 월-일. 날짜 문자열(YYYY-MM-DD)만 받는다. */
export const monthDay = (date: string | null | undefined) => (date ? date.slice(5, 10) : '—');

/** 다른 화면으로 가는 주소 — 공통 주소 표(shared/links.ts)를 그대로 쓴다(M3 통합). */
export { LINK } from '../../shared/links.ts';
