/**
 * 메시지 탭(UI-03-09) — 팀장 ↔ Runner 작업 지시·응답, 원본 P L1351–1380.
 * 이 탭은 읽기만 한다. 작성·재전송·취소는 [작업 실행] 메시지(M3-06)가 맡는다.
 */
import type { UseQueryResult } from '@tanstack/react-query';
import type { ApiError } from '../../../shared/api/client.ts';
import type { ResponseOf } from '../../../shared/api/contract.ts';
import { formatDateTime } from '../../../shared/format.ts';
import { AreaLoading } from '../../../shared/ui/loading.tsx';
import { DELIVERY, DELIVERY_CLASS } from '../labels.ts';
import { ListError, Segs } from '../parts.tsx';

type Message = ResponseOf<'getTaskMessages'>['items'][number];

/** 본문을 줄·코드 블록으로(P L5195 mlines) */
function mlines(body: string): { code: boolean; t: string }[] {
  const out: { code: boolean; t: string }[] = [];
  let inCode = false;
  let buf: string[] = [];
  for (const ln of body.split('\n')) {
    if (ln.trim().startsWith('```')) {
      if (inCode) { out.push({ code: true, t: buf.join('\n') }); buf = []; inCode = false; } else inCode = true;
      continue;
    }
    if (inCode) buf.push(ln); else if (ln.trim()) out.push({ code: false, t: ln });
  }
  if (inCode && buf.length) out.push({ code: true, t: buf.join('\n') });
  return out;
}

export function MessagesTab({ messages }: { messages: UseQueryResult<ResponseOf<'getTaskMessages'>, ApiError> }) {
  const msgs = messages.data?.items ?? [];
  return (
    <div className="pane">
      <div className="pane-h"><div className="pane-hl"><h3>메시지</h3><span className="muted">팀장 ↔ Runner 작업 지시·응답 · 시간순</span></div></div>
      <div className="banner info" style={{ margin: '0 0 14px' }}><div className="banner-b">메시지는 공식 명세를 변경하지 않습니다. 범위·Acceptance Criteria·선행 관계·기술 설계 변경은 메시지의 「Change Proposal 작성」으로 승인 절차를 거칩니다. Runner의 <b>수신 확인</b>은 작업 완료를 의미하지 않습니다.</div></div>
      {messages.data === undefined && (messages.isError ? <ListError label="메시지" error={messages.error} retrying={messages.isFetching} onRetry={() => { void messages.refetch(); }} /> : <AreaLoading label="메시지 불러오는 중" />)}
      {messages.data !== undefined && !msgs.length && <p className="empty">이 Task의 메시지가 없습니다.</p>}
      {msgs.map((m: Message) => {
        const inb = m.dir === 'in';
        const dl = m.delivery === null ? '' : String(m.delivery);
        return (
          <article className={`msg ${inb ? `in${m.readAt ? '' : ' new'}` : 'out'}`} key={m.id} aria-label={`메시지 ${m.msgKey}`}>
            <div className="msg-h">
              <span className="msg-who">{inb ? (m.toAgent === null ? 'Runner' : String(m.toAgent)) : '팀장'}</span><span className="muted">→</span><span className="msg-who">{inb ? '팀장' : m.toAgent === null ? 'Runner' : String(m.toAgent)}</span>
              <span className="mtype">{String(m.type)}</span>
              <span className="mono muted">{formatDateTime(m.createdAt)}</span>
              <span className={`dl ${inb ? 'd-r' : DELIVERY_CLASS[dl] ?? 'd-c'}`} title={inb ? 'Runner가 반환한 Agent 응답' : 'Runner 전달 상태 — 수신 확인은 작업 완료를 의미하지 않습니다'}>{inb ? 'Runner 응답' : `${dl} · ${DELIVERY[dl] ?? ''}`}</span>
              {m.workState && <span className="ws">작업 상태: {m.workState}</span>}
              {inb && !m.readAt && <span className="newtag">새 응답</span>}
            </div>
            <div className="msg-b">
              {mlines(m.body).map((ln, i) => (ln.code ? <pre className="code" key={i}><code>{ln.t}</code></pre> : <p key={i}><Segs text={ln.t} /></p>))}
            </div>
            {!inb && dl === 'Failed' && m.failReason && <div className="banner danger" style={{ marginTop: 6 }}><div className="banner-b"><b>전달 실패</b> — {m.failReason}</div></div>}
          </article>
        );
      })}
    </div>
  );
}
