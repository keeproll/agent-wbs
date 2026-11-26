/**
 * 메시지 보내기 = 초안 만들기(POST /api/messages) → 전송(POST /api/messages/:id/send) 두 요청이다(contracts §2.1).
 * 두 요청에 같은 바탕 키에서 나온 멱등 키를 쓴다. 그래서 「다시 시도」(같은 바탕 키)는
 * 이미 만든 초안을 서버가 그대로 돌려주고(중복 없음), 전송만 이어서 한다.
 */
import type { ApiClient } from '../../shared/api/client.ts';
import type { MessageDraft } from './messageDrafts.ts';

export async function createAndSend(client: ApiClient, taskKey: string, draft: MessageDraft, idempotencyKey: string) {
  const created = await client.call('createMessage', {
    body: { taskKey, type: draft.type, toAgent: draft.toAgent, body: draft.body, ...(draft.attemptId ? { attemptId: draft.attemptId } : {}) },
    idempotencyKey: `${idempotencyKey}.create`,
  });
  // 이미 보낸 뒤 응답만 잃었으면(재시도) 다시 보낼 필요가 없다.
  if (created.delivery !== 'Draft') return created;
  return client.call('sendMessage', {
    params: { messageId: created.id }, body: { updatedAt: created.updatedAt }, idempotencyKey: `${idempotencyKey}.send`,
  });
}
