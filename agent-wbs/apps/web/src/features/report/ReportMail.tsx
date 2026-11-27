/**
 * 보고서 화면의 메일 연결(M6 통합: M6-03 README §9 → M6-01 보고서 화면, G L405).
 *
 * - 「메일 미리보기」: 설정 → 보고서 · 메일 탭과 같은 MailPreview 창(서버가 실제 발송과 같은 함수로 만든 HTML).
 * - 「메일로 보내기」: 원본 openSend·doSend(P L4977-4981)·mailSendVM(P L6542-6550)·마크업(P L2745-2760).
 *   기본 선택은 그 종류를 구독하는 활성 받는 사람이다(기간 지정 보고서는 활성 받는 사람 모두).
 *   보기는 「수신자 기본값 / 모두 팀장용 / 모두 보고용」이고, 일간은 팀장용으로만 보낸다.
 * - Q-13 결정 A: 외부 수신자는 언제나 보고용 + PDF로, 앱 링크 없이 받는다. 일간 보고서에서는 외부 수신자를 고를 수 없다.
 * - 발송 기록 펼침: 원본 rp-sent(P L2131, rp.doc.sent·sentL L6417-6419). 발송 기록을 이 보고서로 거른다.
 *
 * 왜 서버 큐인가: 메일은 보고서 생성과 따로 worker가 보낸다(G L1050). 그래서 「보내기」는 대기열에 넣는 것까지다.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { useAllPages } from '../../shared/api/allPages.ts';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { Modal } from '../../shared/ui/Modal.tsx';
import { useNotice } from '../../shared/ui/feedback.tsx';
import { MailPreview } from '../settings/report/ReportMailTab.tsx';
import { stateLabel, type MailLog, type Recipient, type Smtp } from '../settings/report/model.ts';
import type { ReportRow, ReportView } from './model.ts';

const KIND_L = { daily: '일간', weekly: '주간', custom: '기간' } as const;
/** 원본 mailSendVM views(P L6548). 빈 값은 「수신자 기본값」(view 생략) */
export const SEND_VIEWS: readonly { key: '' | ReportView; l: string }[] = [{ key: '', l: '수신자 기본값' }, { key: 'int', l: '모두 팀장용' }, { key: 'ext', l: '모두 보고용' }];

/** 원본 openSend(P L4977): 그 종류를 구독하는 활성 받는 사람. 기간 지정은 활성 받는 사람 모두. */
export function defaultRecipients(kind: ReportRow['kind'], list: readonly Recipient[]): string[] {
  return list.filter((x) => x.active && !(kind === 'daily' && x.external) && (kind === 'daily' ? x.daily : kind === 'weekly' ? x.weekly : true)).map((x) => x.id);
}
/** 원본 subL(P L6545) */
export const recipientSub = (x: Recipient) =>
  `${[x.daily ? '일간' : '', x.weekly ? '주간' : ''].filter(Boolean).join(' · ')}${x.active ? '' : ' · 중지됨'} · 기본 ${x.view === 'int' ? '팀장용' : '보고용'}${x.external ? ' · 외부(링크 없이 보고용 + PDF)' : ''}`;
/** 원본 smtpL(P L6549). 연결이 확인됐으면 null */
export function smtpWarning(smtp: Smtp | undefined): string | null {
  if (!smtp) return null;
  if (!smtp.host) return 'SMTP 서버가 설정되지 않아 발송이 실패로 기록됩니다. 설정 → 보고서 · 메일에서 먼저 설정하세요.';
  if (smtp.check?.ok === true) return null;
  return `SMTP 연결이 확인되지 않았습니다 (${smtp.check?.ok === false ? '실패' : '확인 전'}) — 보내면 실패로 기록될 수 있습니다.`;
}
/** 원본 sentL(P L6418) */
export function sentLabel(list: readonly MailLog[]): string {
  if (!list.length) return '아직 메일로 보내지 않았습니다.';
  const failed = list.filter((x) => x.state === 'failed').length;
  return `메일 발송 ${String(list.length)}건${failed ? ` · 실패 ${String(failed)}` : ''}`;
}
const repLabel = (r: ReportRow) => `${r.reportKey} · ${KIND_L[r.kind]} 보고 · ${r.from === r.to ? r.from : `${r.from} ~ ${r.to}`}`;

/** 보고서 막대의 두 버튼과 두 창 */
export function ReportMailButtons({ row, view }: { row: ReportRow; view: ReportView }) {
  const [open, setOpen] = useState<'preview' | 'send' | null>(null);
  return (
    <>
      <button type="button" className="btn" onClick={() => { setOpen('preview'); }}>메일 미리보기</button>
      <button type="button" className="btn" onClick={() => { setOpen('send'); }}>메일로 보내기</button>
      {open === 'preview' && <MailPreview target={{ reportId: row.id, kind: row.kind, view, to: null }} onClose={() => { setOpen(null); }} />}
      {open === 'send' && <MailSend row={row} onClose={() => { setOpen(null); }} />}
    </>
  );
}

function MailSend({ row, onClose }: { row: ReportRow; onClose: () => void }) {
  const { client } = useApi();
  const navigate = useNavigate();
  const notify = useNotice();
  const smtp = useApiQuery('getSmtp', {}, { topics: ['mail', 'settings'] });
  const recipients = useApiQuery('listRecipients', {}, { topics: ['mail', 'settings'] });
  const list = useMemo(() => recipients.data?.items ?? [], [recipients.data]);
  // 처음 받은 목록으로 기본 선택을 한 번 정한다(원본 openSend). 그 뒤에는 사용자가 고른 대로 둔다.
  const [picked, setPicked] = useState<Record<string, boolean> | null>(null);
  const ids = picked ?? Object.fromEntries(defaultRecipients(row.kind, list).map((id) => [id, true]));
  const [view, setView] = useState<'' | ReportView>('');
  const [err, setErr] = useState('');
  const chosen = list.filter((x) => ids[x.id] && !(row.kind === 'daily' && x.external)).map((x) => x.id);
  // 보낼 본문은 「보내기」를 누른 순간에 찍어 둔다(request). 다시 시도는 같은 멱등 키로 이 본문을 그대로 보낸다.
  // 왜: 실패 뒤 받는 사람·보기를 바꾸고 다시 시도하면 같은 키로 다른 본문이 나가 409가 되거나 다른 메일이 큐에 들어간다(M6 통합 Codex 리뷰 P2-1).
  const send = useSave<ResponseOf<'sendReportMail'>, { recipientIds: string[]; view?: ReportView }>({
    target: `${row.reportKey} 메일로 보내기`,
    failTitle: '메일을 보내지 못했습니다',
    request: () => ({ recipientIds: chosen, ...(row.kind !== 'daily' && view ? { view } : {}) }),
    run: ({ idempotencyKey, payload }) => client.call('sendReportMail', { params: { reportId: row.id }, idempotencyKey, body: payload }),
    // 건수는 서버가 큐에 넣은 결과에서 센다(지금 화면의 선택이 아니라).
    onSuccess: (result) => { notify(`메일 ${String(result.ids.length)}건을 발송 대기열에 넣었습니다.`); onClose(); },
  });
  const warn = smtpWarning(smtp.data);
  const submit = () => {
    if (!chosen.length) { setErr('받는 사람을 한 명 이상 선택하세요.'); return; }
    void send.save();
  };
  return (
    <Modal title="메일로 보내기" role="dialog" onCancel={onClose} style={{ width: 'min(620px,100%)' }}
      footer={<><span className="sp"></span><button type="button" className="btn" onClick={onClose}>취소</button>
        <BusyButton busy={send.busy} busyLabel="보내는 중…" onClick={submit}>보내기</BusyButton></>}>
      <p style={{ margin: '0 0 10px' }}><b className="mono">{repLabel(row)}</b></p>
      {warn && <div className="banner warn"><div className="banner-b">{warn}</div></div>}
      <h4 style={{ margin: '10px 0 6px' }}>받는 사람</h4>
      {recipients.data && !list.length && (
        <>
          <p className="empty" style={{ margin: '0 0 6px' }}>등록된 받는 사람이 없습니다.</p>
          <button type="button" className="btn sm" onClick={() => { onClose(); void navigate('/settings/report'); }}>설정 → 보고서 · 메일에서 추가</button>
        </>
      )}
      <div className="cl">
        {list.map((x) => (
          <label key={x.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0' }}>
            <input type="checkbox" className="chk" checked={Boolean(ids[x.id]) && !(row.kind === 'daily' && x.external)} disabled={row.kind === 'daily' && x.external} style={{ marginTop: 2 }}
              onChange={() => { setErr(''); setPicked({ ...ids, [x.id]: !ids[x.id] }); }} />
            <span className="tcell"><b className="mono" style={{ fontSize: 12.5 }}>{x.email}</b><span className="tid">{`${x.name} · ${recipientSub(x)}${row.kind === 'daily' && x.external ? ' — 일간 보고서는 외부 수신자에게 보내지 않습니다' : ''}`}</span></span>
          </label>
        ))}
      </div>
      {row.kind !== 'daily' ? (
        <>
          <h4 style={{ margin: '12px 0 6px' }}>보기</h4>
          <div className="seg" role="group" aria-label="보낼 보기">
            {SEND_VIEWS.map((o) => <button key={o.key} type="button" aria-pressed={view === o.key} onClick={() => { setView(o.key); }}>{o.l}</button>)}
          </div>
          {list.some((x) => ids[x.id] && x.external) && <p className="fhint" style={{ margin: '6px 0 0' }}>외부 수신자는 어떤 보기를 골라도 보고용 + PDF로, 앱 링크 없이 받습니다.</p>}
        </>
      ) : <p className="fhint" style={{ margin: '10px 0 0' }}>일간 보고서는 팀장용(상세)으로 보냅니다.</p>}
      {err && <p className="ferr" role="alert">{err}</p>}
      {send.conflictModal}
    </Modal>
  );
}

/** 발송 기록 펼침(원본 rp-sent P L2131). 최근 것부터. */
export function ReportSent({ reportId }: { reportId: string }) {
  const log = useAllPages('listMailLog', {}, { topics: ['mail', 'report'] });
  const sent = useMemo(() => (log.data?.items ?? []).filter((x) => x.reportId === reportId), [log.data, reportId]);
  return (
    <details className="rp-sent rp-noprint">
      <summary>{sentLabel(sent)}</summary>
      {sent.length > 0 && (
        <div className="gtb" style={{ margin: '6px 0 0' }}>
          {sent.map((x) => {
            const s = stateLabel(x.state);
            return (
              <div key={x.id} className="gtr" style={{ gridTemplateColumns: '112px minmax(160px,1fr) 70px minmax(120px,1fr)', minWidth: 0 }}>
                <span className="gc mono">{formatDateTime(x.at).slice(5)}</span><span className="gc mono">{x.to}</span>
                <span className="gc"><span className={s.cls}>{s.label}</span></span><span className="gc">{x.reason}</span>
              </div>
            );
          })}
        </div>
      )}
    </details>
  );
}
