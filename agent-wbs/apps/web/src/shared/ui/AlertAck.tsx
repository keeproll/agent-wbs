/**
 * 「팀장 확인 필요」 알림의 「확인」 버튼(원본 P L1865·L2431, dismissAlert L6224).
 * 서버 후속 3차 POST /api/alerts/:id/ack(ackAlert, 204)에 연결했다(M3 통합). 확인한 알림은 GET /api/alerts에서 빠진다.
 * - 확인은 「읽었다」는 표시일 뿐이다. 원인을 해소하지 않는다(서버가 resolved_at을 바꾸지 않음).
 * - 같은 알림을 다시 확인해도 204라 다시 시도해도 안전하다. 공통 useSave 규칙(버튼 「…중」·오류 막대·같은 키 재시도)을 쓴다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/ApiProvider.tsx';
import { invalidateTopics } from '../api/queries.ts';
import { useSave } from '../state/useSave.tsx';
import { BusyButton } from './BusyButton.tsx';

export function AlertAck({ id, label }: { id: string; label: string }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const { save, busy } = useSave<unknown>({
    target: `알림 확인 — ${label}`,
    failTitle: '알림을 확인 처리하지 못했습니다',
    run: ({ idempotencyKey }) => client.call('ackAlert', { params: { id }, idempotencyKey }),
    onSuccess: () => { void invalidateTopics(queryClient, ['alert']); },
    successNotice: '알림을 확인 처리했습니다.',
  });
  return <BusyButton small variant="ghost" busy={busy} busyLabel="확인 중…" aria-label={`${label} 알림 확인`} onClick={() => { void save(); }}>확인</BusyButton>;
}
