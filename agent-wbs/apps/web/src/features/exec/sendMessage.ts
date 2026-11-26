/**
 * 메시지 보내기 = 초안 만들기(POST /api/messages) → 전송(POST /api/messages/:id/send) 두 요청이다(contracts §2.1).
 *
 * - 두 요청에 같은 바탕 키에서 나온 멱등 키(`<키>.create`, `<키>.send`)를 쓴다.
 *   「다시 시도」(같은 바탕 키)는 이미 만든 초안을 서버가 그대로 돌려주므로 중복이 생기지 않는다.
 * - 이미 만든 메시지(`created`)가 있으면 새로 만들지 않는다. 충돌 뒤 「다시 적용」은 새 키를 쓰므로,
 *   만들기를 다시 하면 같은 지시가 두 개 생긴다(M3-06 리뷰 #2). 그때는 서버의 최신 상태를 읽어 전송만 이어 간다.
 */
import type { ApiClient } from '../../shared/api/client.ts';
import type { MessageDraft } from './messageDrafts.ts';
import type { ExecMessage } from './model.ts';

/** 만든 메시지. sent면 전송까지 끝났다. */
export interface CreatedMessage { id: string; msgKey: string; sent: boolean }

export interface SendInput {
  client: ApiClient;
  taskKey: string;
  draft: MessageDraft;
  idempotencyKey: string;
  /** 이 내용으로 이미 만든 메시지. 있으면 만들기를 건너뛴다. */
  created: CreatedMessage | null;
  /** 만들기·전송이 성공할 때마다 알린다(다음 단계가 실패해도 「이미 만든·보낸 메시지」를 기억하게). */
  onCreated: (message: CreatedMessage) => void;
}

/** 서버에서 그 메시지의 최신 상태를 읽는다(전송에 필요한 updatedAt). */
export async function latestMessage(client: ApiClient, taskKey: string, id: string): Promise<ExecMessage> {
  let cursor: string | undefined;
  for (;;) {
    const page = await client.call('getTaskMessages', { params: { taskKey }, query: { limit: 200, ...(cursor ? { cursor } : {}) } });
    const found = page.items.find((m) => m.id === id);
    if (found) return found;
    if (!page.nextCursor) throw new Error('보낸 메시지를 찾을 수 없습니다.');
    cursor = page.nextCursor;
  }
}

export async function sendMessage({ client, taskKey, draft, idempotencyKey, created, onCreated }: SendInput): Promise<ExecMessage | null> {
  // 전송까지 끝난 메시지는 다시 건드리지 않는다.
  if (created?.sent) return null;
  let message: ExecMessage;
  if (created) {
    message = await latestMessage(client, taskKey, created.id);
  } else {
    message = await client.call('createMessage', {
      body: { taskKey, type: draft.type, toAgent: draft.toAgent, body: draft.body, ...(draft.attemptId ? { attemptId: draft.attemptId } : {}) },
      idempotencyKey: `${idempotencyKey}.create`,
    });
    onCreated({ id: message.id, msgKey: message.msgKey, sent: false });
  }
  // 이미 보낸 뒤 응답만 잃었으면 다시 보낼 필요가 없다.
  if (message.delivery === 'Draft') {
    message = await client.call('sendMessage', {
      params: { messageId: message.id }, body: { updatedAt: message.updatedAt }, idempotencyKey: `${idempotencyKey}.send`,
    });
  }
  onCreated({ id: message.id, msgKey: message.msgKey, sent: true });
  return message;
}
