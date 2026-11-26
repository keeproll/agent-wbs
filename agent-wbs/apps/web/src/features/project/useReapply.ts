/**
 * 충돌 창 「최신 내용에 내 변경 다시 적용」의 요청을 결과가 확인될 때까지 붙잡아 두는 hook(리뷰 M3-04 P2).
 *
 * 왜: 재적용 요청의 응답만 잃으면(네트워크 끊김·500·10초 초과) 서버는 이미 처리했을 수 있다.
 * 그때 최신을 다시 읽어 새 멱등 키로 보내면 같은 의도가 두 번 처리된다(예: recheck가 1이 아니라 2로 오름).
 * 그래서 결과를 모르는 재적용이 남아 있으면, 다음 재적용은 최신을 다시 읽지 않고 **같은 본문·같은 키**로 다시 보낸다.
 *
 * - 성공하거나, 다시 보내도 소용없는 실패(400·409 등)를 받으면 붙잡은 요청을 버린다.
 *   다음 재적용은 그때 최신을 새로 읽어 새 키로 만든다.
 * - useSave의 일반 저장·「다시 시도」와는 별개다. 그쪽 키는 useSave가 보관한다.
 */
import { useRef } from 'react';
import { ApiError } from '../../shared/api/client.ts';
import { canRetry } from '../../shared/ui/errors.ts';

export function useReapply<B>() {
  const pending = useRef<{ key: string; body: B } | null>(null);
  return async <R>(build: () => Promise<B>, send: (body: B, idempotencyKey: string) => Promise<R>): Promise<R> => {
    const current = pending.current ?? { key: crypto.randomUUID(), body: await build() };
    pending.current = current;
    try {
      const result = await send(current.body, current.key);
      pending.current = null;
      return result;
    } catch (error) {
      if (!(error instanceof ApiError) || !canRetry(error)) pending.current = null;
      throw error;
    }
  };
}
