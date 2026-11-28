/**
 * 시도의 지정 · 실제 하위 Agent 태그 문구(UAT-TASK-10, 원본 P L1310 · L5309).
 * 값은 계약 `Attempt.subagents`에서만 온다. 없으면 태그를 그리지 않는다(지어내지 않음).
 * - 지정: 실행 시작 때 Runner가 설치한 지정 정의 「id vN, …」.
 * - 실제(실행 중): 출력 스트림 관측 수 「실행 중 · 관측 N개 (추정)」. 관측이 끊겼으면 「— 미확인 · 보유」, 노란 태그.
 * - 실제(끝난 뒤): Runner 사후 보고 「id vN ×n, … · 세션 기록 확인|일부 관측」. 확인은 초록, 일부 관측은 노란 태그.
 * - 지정 미사용: 세션 기록으로 **확인된** 보고에 지정 정의가 없을 때만 띄운다.
 *   왜 확인일 때만: 「일부 관측」은 못 본 것이 있을 수 있어, 안 썼다고 말할 근거가 없다(원본은 일부 관측에도 띄우지만 Mock 값이 그 경우를 만들지 않는다).
 */
import type { ResponseOf } from './api/contract.ts';

export type AttemptSubagents = ResponseOf<'getTaskAttempts'>['items'][number]['subagents'];

export interface SubagentTagView {
  /** 「지정 …」 뒤 문구. 지정이 없으면 null */
  designated: string | null;
  /** 「실제 …」 뒤 문구와 태그 class. 보여 줄 실제 값이 없으면 null */
  used: { label: string; cls: string } | null;
  /** 「지정 미사용 — …」 문구. 없으면 null */
  missing: string | null;
}

const CONFIRM_LABEL = { confirmed: '세션 기록 확인', partial: '일부 관측' } as const;

export function subagentView(s: AttemptSubagents, running: boolean): SubagentTagView {
  const designated = s.designated.length ? s.designated.map((x) => `${x.id} v${String(x.version)}`).join(', ') : null;
  let used: SubagentTagView['used'] = null;
  if (running) {
    if (s.observed) {
      const unconf = s.observed.state === 'unconfirmed';
      used = { label: `실행 중 · 관측 ${String(s.observed.count)}개 (추정${unconf ? ' — 미확인 · 보유' : ''})`, cls: unconf ? 'tag chg' : 'tag' };
    }
  } else if (s.used && s.used.items.length) {
    const items = s.used.items.map((x) => `${x.id}${x.version === null ? '' : ` v${String(x.version)}`} ×${String(x.count)}`).join(', ');
    used = { label: `${items} · ${CONFIRM_LABEL[s.used.confirm]}`, cls: s.used.confirm === 'confirmed' ? 'tag new' : 'tag chg' };
  }
  const report = s.used;
  const unused = !running && report?.confirm === 'confirmed' ? s.designated.filter((d) => !report.items.some((u) => u.id === d.id)).map((d) => d.id) : [];
  return { designated, used, missing: unused.length ? `지정 미사용 — ${unused.join(', ')}` : null };
}

/** 개요 탭 「실행 기록」 줄의 「하위 Agent …」 태그(P L6265 subsL). 지정이 없으면 null */
export function designatedLabel(s: AttemptSubagents): string | null {
  return subagentView(s, false).designated;
}
