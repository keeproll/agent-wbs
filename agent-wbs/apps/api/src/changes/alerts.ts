import type { PoolClient } from '@awbs/db';
import { iso, refText } from './events.ts';

/**
 * 현재 상태 알림(contracts §2.2 `GET /api/alerts`, data-model §2.8 `alerts`). 조정자 결정 2026-11-26: M2에서 구현한다.
 * - 원인이 해소되지 않았고 팀장이 확인하지 않은 알림만 준다. 확인은 보호 상태를 해제하지 않는다.
 * - 최신 먼저(created_at 내림차순, 같으면 id).
 * - target(jsonb)은 화면이 다시 읽을 참조 문자열로 바꾼다(변경 이벤트 ref와 같은 규칙: taskKey → id → key, 없으면 정렬 JSON).
 * - text는 target.message가 있으면 그것, 없으면 key다. taskKey는 target.taskKey가 있을 때만.
 * Telegram 외부 발송(M6-04)과는 별개다. 이 API는 대시보드·작업 실행 화면(M3)이 현재 경고를 보여 주는 데 쓴다.
 */
export async function listAlerts(client: PoolClient) {
  const rows = (await client.query<{ id: string; key: string; severity: string; target: Record<string, unknown> | null; at: string }>(
    `select id,key,severity,target,${iso('created_at')} as at from alerts where resolved_at is null and acknowledged_at is null order by created_at desc,id desc`)).rows;
  return {
    items: rows.map((row) => {
      const target = row.target ?? {};
      const message = typeof target.message === 'string' && target.message.trim() ? target.message : row.key;
      const taskKey = typeof target.taskKey === 'string' && /^TASK-[0-9]{4,}$/.test(target.taskKey) ? target.taskKey : null;
      return { id: row.id, key: row.key, severity: row.severity, taskKey, target: refText(target), text: message, at: row.at };
    }),
  };
}
