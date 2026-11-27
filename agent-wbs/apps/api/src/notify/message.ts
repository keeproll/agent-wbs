import { redactText } from '../platform/redact.ts';

export const EVENTS = { done: 'Task 완료', fail: 'Task 실패', admin: '관리자 개입 필요', approve: '승인 요청', buildOk: '빌드 성공', buildFail: '빌드 실패' } as const;
export type NotifyEvent = keyof typeof EVENTS;
export const DEFAULT_RULES = { done: false, fail: true, admin: true, approve: true, buildOk: false, buildFail: true };
export interface MessageInput { event: NotifyEvent | null; project: string; target: string; state: string; path: string; at: string; reason?: string }
const clean = (value: string, max: number) => redactText(value).replace(/[\r\n\t]/g, ' ').slice(0, max);

export function message(input: MessageInput, appUrl: string | null): string {
  const lines = [`[Agent WBS] ${input.event ? EVENTS[input.event] : '테스트 알림'}`, `프로젝트: ${clean(input.project, 300)}`,
    `대상: ${clean(input.target, 1200)}`, `상태: ${clean(input.state, 400)}`];
  if (input.reason) lines.push(`이유: 원인 후보: ${clean(input.reason, 400)} (미확정)`);
  lines.push(`발생: ${input.at}`, '다음 행동: WBS에서 상세 내용과 근거를 확인하세요.');
  if (appUrl && /^\/(?:wbs|change|ci|design|settings|project)(?:\/[^\s?#]*)?$/.test(input.path)) {
    lines.push(`WBS에서 확인: ${appUrl.replace(/\/$/, '')}${input.path}`);
  }
  return lines.join('\n').slice(0, 4096);
}
