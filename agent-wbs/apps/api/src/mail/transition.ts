/**
 * 메일 발송 결과 전이표(M6-03 fix3, Codex 재리뷰 P1, contracts §4.4, data-model §3.7).
 *
 * SMTP 결과가 도착했을 때 그 큐 줄의 상태를 어떻게 바꿀지 **이 표 하나**로 정한다.
 * 결과 기록 코드(deliver.ts)는 이 표만 보고 움직인다. 모든 칸은 test/mail-transition.test.ts가 시험한다.
 *
 * 원칙:
 * 1. 결과 기록은 **그 시도(attempt ID)가 아직 현재 시도일 때만** 상태를 바꾼다.
 *    - 왜: 정리 · 재찜 뒤에 도착한 옛 시도의 응답이 지금 상태를 덮으면, 이미 끝난 일을 다시 움직인다.
 *    - 낡은 결과는 받은 사실만 이력(mail_log)에 남긴다.
 * 2. unknown(수락 여부 불명)에서 허용되는 늦은 전이는 **accepted뿐**이다.
 *    - 늦은 거부(451 등)는 이력에만 남기고 자동 재시도(retry_wait)를 다시 켜지 않는다.
 *    - 왜: unknown이 된 뒤에는 사람이 「다시 보내기」로 새 발송을 만들 수 있다. 늦은 거부로 원본을 재시도에 올리면 프로그램이 한 통을 더 보낸다(재리뷰 재현).
 *      늦은 수락은 「받았다」는 사실이 확정된 것이므로 고친다. 자동 발송을 만들지 않는다.
 *
 * 들어온 결과(Incoming):
 * - accepted: 서버가 250으로 수락
 * - rejected: 수락되지 않은 것이 확실(연결 전 실패 · 535 · 4xx · 5xx · SMTP 미설정 · PDF 실패)
 * - unknown: 본문을 보낸 뒤 응답을 못 받음
 * - record_lost: 결과를 몇 번 적으려 했지만 DB에 적지 못함(받은 응답이 무엇이든 확정할 수 없다)
 */
export const MAIL_STATES = ['queued', 'sending', 'accepted', 'retry_wait', 'failed', 'unknown'] as const;
export type MailState = (typeof MAIL_STATES)[number];
export const INCOMING = ['accepted', 'rejected', 'unknown', 'record_lost'] as const;
export type Incoming = (typeof INCOMING)[number];

/** 칸의 동작. `retry_or_failed` = 자동 재시도 전이면 retry_wait, 이미 했으면 failed. `keep` = 상태 그대로 */
type Move = 'accepted' | 'unknown' | 'retry_or_failed' | 'keep';
type Cell = readonly [Move, boolean];

/** 현재 시도의 결과: [현재 상태][들어온 결과] → [동작, 이력에 남기나] */
const CURRENT: Record<MailState, Record<Incoming, Cell>> = {
  // 보내는 중: 결과대로 확정한다.
  sending: { accepted: ['accepted', true], rejected: ['retry_or_failed', true], unknown: ['unknown', true], record_lost: ['unknown', true] },
  // 정리로 불명이 된 뒤의 늦은 결과: 수락만 고치고, 나머지는 이력만(재시도 되살리기 금지).
  unknown: { accepted: ['accepted', true], rejected: ['keep', true], unknown: ['keep', true], record_lost: ['keep', false] },
  // 아래는 현재 시도의 결과가 이미 적힌 뒤 같은 결과를 다시 적으려는 경우(기록 커밋 응답 유실 뒤 재시도 등)이거나 일어나지 않는 칸이다.
  // 이미 확정한 것을 다시 움직이지 않고, 같은 줄을 두 번 이력에 남기지 않는다.
  queued: { accepted: ['keep', false], rejected: ['keep', false], unknown: ['keep', false], record_lost: ['keep', false] },
  accepted: { accepted: ['keep', false], rejected: ['keep', false], unknown: ['keep', false], record_lost: ['keep', false] },
  retry_wait: { accepted: ['keep', false], rejected: ['keep', false], unknown: ['keep', false], record_lost: ['keep', false] },
  failed: { accepted: ['keep', false], rejected: ['keep', false], unknown: ['keep', false], record_lost: ['keep', false] },
};

export interface Transition { to: MailState | null; log: boolean }

/** 결과가 도착했을 때의 전이. to=null이면 상태를 바꾸지 않는다. log=true면 받은 결과를 이력에 남긴다. */
export function mailTransition(state: MailState, incoming: Incoming, attempt: { current: boolean; retried: boolean }): Transition {
  // 낡은 시도의 결과: 상태는 그대로, 실제로 받은 응답만 이력에 남긴다(원칙 1).
  if (!attempt.current) return { to: null, log: incoming !== 'record_lost' };
  const [move, log] = CURRENT[state][incoming];
  if (move === 'keep') return { to: null, log };
  if (move === 'retry_or_failed') return { to: attempt.retried ? 'failed' : 'retry_wait', log };
  return { to: move, log };
}
