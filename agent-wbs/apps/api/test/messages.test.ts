// M2-08 메시지 전달 상태(data-model §3.3, G§4.10·§9.4)의 순수 판정. DB를 쓰는 검증은 messages.db.test.ts.
import { describe, expect, test } from 'vitest';
import { DELIVERIES, messageView, nextDelivery, pendingNextAtSend, type MessageAction } from '../src/messages/state.ts';

const table: Record<MessageAction, Partial<Record<(typeof DELIVERIES)[number], string>>> = {
  edit: { Draft: 'Draft' },
  send: { Draft: 'Queued' },
  cancel: { Draft: 'Cancelled', Queued: 'Cancelled' },
  resend: { Failed: 'Queued' },
  poll: { Queued: 'Sent', Sent: 'Sent' },
  ack: { Queued: 'Acknowledged', Sent: 'Acknowledged', Acknowledged: 'Acknowledged', Failed: 'Acknowledged' },
  fail: { Queued: 'Failed', Sent: 'Failed' },
};

describe('nextDelivery — 모든 상태×동작 쌍', () => {
  for (const [action, allowed] of Object.entries(table) as [MessageAction, Record<string, string>][]) {
    for (const from of DELIVERIES) {
      test(`${action}: ${from} → ${allowed[from] ?? '거부'}`, () => {
        expect(nextDelivery(from, action)).toBe(allowed[from] ?? null);
      });
    }
  }
  test('수신 확인(Acknowledged)은 작업 완료가 아니다 — 확인 뒤에도 전달 상태만 바뀐다', () => {
    expect(DELIVERIES).not.toContain('Done');
  });
});

describe('pendingNextAtSend — 실행 중 전달(G§4.10)', () => {
  test('Q-07: 실행 중이면 항상 다음 실행 대기', () => {
    expect(pendingNextAtSend({ taskRunning: true })).toBe(true);
  });
  test('실행 중이 아니면 바로 전달 대기열', () => {
    expect(pendingNextAtSend({ taskRunning: false })).toBe(false);
  });
});

describe('messageView — DB 행을 API 모양으로', () => {
  const base = {
    id: 'm1', msg_key: 'MSG-001', task_key: 'TASK-0001', attempt: null, dir: 'out', type: '질문', to_agent: 'Codex', from_agent: null,
    body: '본문', delivery: 'Queued', pending_next: false, work_state: '', fail_reason: null, read_at: null,
    created_at: '2026-11-26T00:00:00.000001Z', updated_at: '2026-11-26T00:00:00.000002Z',
  };
  test('빈 work_state는 null(응답 없음)', () => {
    expect(messageView(base)).toEqual({
      id: 'm1', msgKey: 'MSG-001', taskKey: 'TASK-0001', attemptId: null, dir: 'out', type: '질문', toAgent: 'Codex', body: '본문',
      delivery: 'Queued', pendingNext: false, workState: null, failReason: null, readAt: null,
      createdAt: '2026-11-26T00:00:00.000001Z', updatedAt: '2026-11-26T00:00:00.000002Z',
    });
  });
  test('들어온 응답은 전달 상태가 없고 작업 상태를 보인다(세 상태는 별도 필드, G§9.4-1)', () => {
    expect(messageView({ ...base, dir: 'in', type: '응답', to_agent: null, from_agent: 'Codex', delivery: null, work_state: '재작업 반영 예정' }))
      .toMatchObject({ dir: 'in', toAgent: null, delivery: null, workState: '재작업 반영 예정' });
  });
});
