/**
 * 메시지 전달 상태(data-model §3.3, G§4.10).
 * - 전달 상태(delivery), 다음 실행 대기(pendingNext), Agent의 작업 상태(workState)는 서로 다른 사실이라 별도 필드다(G§9.4-1).
 * - 「Acknowledged」는 Runner가 받았다는 뜻일 뿐 작업 완료가 아니다.
 */
export const DELIVERIES = ['Draft', 'Queued', 'Sent', 'Acknowledged', 'Cancelled', 'Failed'] as const;
export type Delivery = (typeof DELIVERIES)[number];

/**
 * - edit: 초안 수정 / send: 전송 요청 / cancel: 취소 / resend: 실패 후 재전송
 * - poll: Runner가 가져감(Queued→Sent, 이미 Sent면 그대로 — 응답을 잃은 Runner의 재조회)
 * - ack: Runner 수신 확인 / fail: 전달 실패(Runner 연결 끊김 등, 서버 판정)
 */
export type MessageAction = 'edit' | 'send' | 'cancel' | 'resend' | 'poll' | 'ack' | 'fail';

const NEXT: Record<MessageAction, Partial<Record<Delivery, Delivery>>> = {
  edit: { Draft: 'Draft' },
  send: { Draft: 'Queued' },
  // Draft/Queued → Cancelled. Runner가 이미 가져간(Sent) 메시지는 되돌릴 수 없다.
  cancel: { Draft: 'Cancelled', Queued: 'Cancelled' },
  resend: { Failed: 'Queued' },
  poll: { Queued: 'Sent', Sent: 'Sent' },
  // 이미 확인한 것은 그대로(재전송된 ack). 실패로 표시된 뒤 도착한 ack는 실제로 받았다는 증거라 확인으로 바꾼다.
  ack: { Queued: 'Acknowledged', Sent: 'Acknowledged', Acknowledged: 'Acknowledged', Failed: 'Acknowledged' },
  fail: { Queued: 'Failed', Sent: 'Failed' },
};

/** 그 동작이 허용되면 다음 상태, 아니면 null. */
export function nextDelivery(current: Delivery, action: MessageAction): Delivery | null {
  return NEXT[action][current] ?? null;
}

/**
 * 전송 시 「다음 실행 대기」로 둘지(P `deliver` L5418-5421).
 * Q-07(owner 2026-11-27 아이템 18): 실행 중인 Task의 메시지는 항상 다음 실행 시작 때 전달한다.
 * 실시간 세션 제어를 지원하는 것처럼 표현하지 않기 위해서다(G§4.10).
 */
export function pendingNextAtSend(input: { taskRunning: boolean }): boolean {
  return input.taskRunning;
}

export interface MessageRow {
  id: string; msg_key: string; task_key: string; attempt: string | null; dir: string; type: string; to_agent: string | null; from_agent: string | null;
  body: string; delivery: string | null; pending_next: boolean; work_state: string; fail_reason: string | null; read_at: string | null;
  created_at: string; updated_at: string;
}

/** DB 행 → API `Message`. 작업 상태가 빈 문자열이면 「아직 응답 없음」이라 null로 보인다. */
export function messageView(row: MessageRow) {
  return {
    id: row.id, msgKey: row.msg_key, taskKey: row.task_key, attemptId: row.attempt, dir: row.dir, type: row.type, toAgent: row.to_agent,
    body: row.body, delivery: row.delivery, pendingNext: row.pending_next, workState: row.work_state === '' ? null : row.work_state,
    failReason: row.fail_reason, readAt: row.read_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
