/**
 * 설정 → 보고서 · 메일 탭(UI-12-04, P L2511-2580 · mailVM L6496-6531 · 메일 미리보기 L2725-2741, G§4.11 L398-408).
 *
 * 카드 셋: 받는 사람(표 + 추가 폼) · 메일 서버(SMTP) · 발송 기록. 원본과 같은 클래스(.gtr.mrow·.gtr.lrow·.seg·.banner·.empty-box·.mail-fr)를 쓴다.
 *
 * 원본과 다른 점(제품 결정, README §3):
 * - 「Mock: SMTP 인증 실패 · 정상 복구」 버튼이 없다. 실패는 실제 연결 확인·발송 결과로만 생긴다(UAT-POLICY-05).
 * - 발송 상태에 「대기 · 보내는 중 · 15분 후 재시도 · 수락 여부 불명」이 더 있다. 원본은 즉시 「발송됨/실패」였다(서버 발송 큐, data-model §3.7).
 * - 받는 사람의 「등록 시각」은 계약 응답에 없어 이름만 보인다.
 * - Q-13 결정 A: 받는 사람 행과 추가 폼에 「외부」 단추가 있다(원본에 없음). 켜면 일간 끔 · 보고용 · PDF 첨부로 고정되고, 메일에 앱 링크가 들어가지 않는다.
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../../shared/api/ApiProvider.tsx';
import { useAllPages } from '../../../shared/api/allPages.ts';
import type { ResponseOf } from '../../../shared/api/contract.ts';
import { useApiQuery } from '../../../shared/api/queries.ts';
import { formatDateTime } from '../../../shared/format.ts';
import { useRefreshError } from '../../../shared/layout/MenuScreen.tsx';
import { useSave } from '../../../shared/state/useSave.tsx';
import { BusyButton } from '../../../shared/ui/BusyButton.tsx';
import { Modal } from '../../../shared/ui/Modal.tsx';
import { useNotice } from '../../../shared/ui/feedback.tsx';
import { TableScroll } from '../../../shared/ui/TableScroll.tsx';
import { CardHead, QueryGate, Row, Seg } from '../ui.tsx';
import { DirtyContext } from '../useSettingForm.tsx';
import {
  BLANK_RECIPIENT, EXTERNAL_HINT, LOG_LIMIT, SECURITY, VIEW_LABEL, lastSend, recipientError, recipientSummary, smtpError, stateLabel, withExternal,
  type MailLog, type Recipient, type RecipientForm, type Smtp, type SmtpForm,
} from './model.ts';

const at = (value: string | null | undefined) => (value ? formatDateTime(value) : '—');
/** 「11-05 20:00」(P mailVM recL: 연도 생략) */
const short = (value: string) => formatDateTime(value).slice(5);
const MAIL = ['mail', 'settings'] as const;
/** 미리보기 창에 넘기는 것: 보고서 · 처음 보기 · 받는 사람(ID가 있으면 그 사람 기본값 · 첨부) */
interface PreviewTarget { reportId: string; kind: string; view: 'int' | 'ext'; to: string | null }

export function ReportMailTab({ projectId }: { projectId: string | null }) {
  const smtp = useApiQuery('getSmtp', {}, { topics: MAIL });
  const recipients = useApiQuery('listRecipients', {}, { topics: MAIL });
  const log = useAllPages('listMailLog', {}, { topics: ['mail', 'report'] });
  useRefreshError(smtp, '메일 서버 설정 최신 내용 불러오기');
  useRefreshError(recipients, '받는 사람 최신 내용 불러오기');
  useRefreshError(log, '발송 기록 최신 내용 불러오기');
  const reports = useAllPages('listReports', { params: { projectId: projectId ?? '' } }, { topics: ['report'], enabled: projectId !== null });
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const refresh = () => { void smtp.refetch(); void recipients.refetch(); void log.refetch(); };
  const reportList = reports.data?.items ?? [];
  const openFor = (r: Recipient) => {
    // 원본 pv: 주간만 받는 사람은 최신 주간, 아니면 최신 보고서(P mailVM L6503)
    // 외부 수신자는 일간을 받지 않으므로 최신 주간을 보인다(Q-13 결정 A).
    const pick = reportList.filter((x) => (r.external || (r.weekly && !r.daily) ? x.kind === 'weekly' : true))[0];
    if (pick) setPreview({ reportId: pick.id, kind: pick.kind, view: r.view, to: r.id });
    return Boolean(pick);
  };
  return (
    <>
      <RecipientsCard smtp={smtp.data} recipients={recipients} log={log.data?.items ?? []} onPreview={openFor} refresh={refresh} />
      <SmtpCard smtp={smtp} refresh={refresh} />
      <LogCard log={log} recipients={recipients.data?.items ?? []} reports={reportList} onPreview={setPreview} refresh={refresh} />
      {preview && <MailPreview target={preview} onClose={() => { setPreview(null); }} />}
    </>
  );
}

/* ---------------- 받는 사람(P L2512-2541) ---------------- */

function RecipientsCard({ smtp, recipients, log, onPreview, refresh }: {
  smtp: Smtp | undefined; recipients: ReturnType<typeof useApiQuery<'listRecipients'>>; log: readonly MailLog[];
  onPreview: (r: Recipient) => boolean; refresh: () => void;
}) {
  const list = recipients.data?.items ?? [];
  const configured = Boolean(smtp?.host);
  const smtpBad = configured && smtp?.check?.ok === false;
  return (
    <section className="card" aria-labelledby="set-mail-rc">
      <CardHead id="set-mail-rc" title="보고서 메일 — 받는 사람"><span className="muted">{recipientSummary(list)}</span></CardHead>
      <p className="fhint" style={{ margin: '0 0 10px' }}>등록한 주소로 보고서가 생성되는 즉시 HTML 메일을 보냅니다 — <b>일간</b>: 매일 07:00 · <b>주간</b>: 매주 월요일 07:00. PC가 꺼져 정기 생성이 늦어지면 늦게 생성된 보고서를 그때 보냅니다. 일간 보고서는 항상 팀장용(상세)으로, 주간 보고서는 수신자별 보기(팀장용 · 보고용)로 보냅니다.</p>
      {smtpBad && <div className="banner danger" role="alert"><div className="banner-b"><b>메일 서버 연결 실패</b> — 지금은 보고서 메일이 발송되지 않고 실패로 기록됩니다. 아래 「메일 서버(SMTP)」를 확인하세요.</div></div>}
      {smtp && !configured && list.length > 0 && <div className="banner warn" role="note"><div className="banner-b">메일 서버(SMTP)가 아직 설정되지 않아 수신자를 등록해도 발송되지 않습니다.</div></div>}
      <QueryGate query={recipients} label="받는 사람" />
      {recipients.data && (
        <TableScroll minWidth={1080} label="받는 사람 표">
          <div className="gtb" style={{ margin: '0 0 12px' }}>
            <div className="gtr h mrow"><span className="gc">받는 사람</span><span className="gc">일간</span><span className="gc">주간</span><span className="gc">주간 보기</span><span className="gc">PDF 첨부</span><span className="gc">최근 발송</span><span className="gc">상태</span><span className="gc"></span></div>
            {list.length === 0 && <div className="gtr"><span className="gc muted">등록된 받는 사람이 없습니다. 아래에서 이메일 주소를 추가하세요 — 여러 개 등록할 수 있습니다.</span></div>}
            {list.map((r) => <RecipientRow key={r.id} r={r} last={lastSend(log, r.id)} onPreview={onPreview} refresh={refresh} />)}
          </div>
        </TableScroll>
      )}
      <AddRecipient existing={list} refresh={refresh} />
    </section>
  );
}

function RecipientRow({ r, last, onPreview, refresh }: { r: Recipient; last: ReturnType<typeof lastSend>; onPreview: (r: Recipient) => boolean; refresh: () => void }) {
  const { client } = useApi();
  const notify = useNotice();
  const [note, setNote] = useState('');
  interface Patch { daily?: boolean; weekly?: boolean; view?: 'int' | 'ext'; pdf?: boolean; external?: boolean; active?: boolean }
  // useSave는 누른 순간의 요청 내용을 request()로 찍는다. 버튼마다 내용이 달라 누르기 직전에 ref에 적어 둔다.
  const next = useRef<{ body: Patch; note: string }>({ body: {}, note: '' });
  const patch = useSave<ResponseOf<'updateRecipient'>, { body: Patch; note: string }>({
    target: `${r.email} 수신 설정 저장`,
    request: () => next.current,
    run: ({ payload }) => client.call('updateRecipient', { params: { id: r.id }, body: { updatedAt: r.updatedAt, ...payload.body } }),
    onSuccess: (_row, payload) => { refresh(); notify(payload.note); },
    onConflictReload: () => { refresh(); },
    mine: '수신 설정 변경',
  });
  const send = (body: Patch, note = '수신 설정을 저장했습니다.') => { next.current = { body, note }; void patch.save(); };
  const test = useSave<ResponseOf<'testRecipient'>>({
    target: `${r.email} 테스트 발송`,
    failTitle: '테스트 메일을 보내지 못했습니다',
    run: ({ idempotencyKey }) => client.call('testRecipient', { params: { id: r.id }, idempotencyKey }),
    onSuccess: () => { refresh(); },
    successNotice: '테스트 메일을 발송 대기열에 넣었습니다 — 결과는 발송 기록에 남습니다.',
  });
  const remove = useSave<undefined>({
    target: `${r.email} 받는 사람 삭제`,
    run: () => client.call('deleteRecipient', { params: { id: r.id }, query: { updatedAt: r.updatedAt } }),
    onSuccess: () => { refresh(); },
    onConflictReload: () => { refresh(); },
    successNotice: `${r.email} 수신자를 삭제했습니다. 발송 기록은 남습니다.`,
  });
  const busy = patch.busy || remove.busy;
  return (
    <div className={r.active ? 'gtr mrow' : 'gtr mrow off'} data-testid={`recipient-${r.email}`}>
      <span className="gc"><span className="tcell">
        <b className="mono" style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{r.email}</b>
        <span className="tid">{`${r.name || '—'} · 등록 ${short(r.createdAt)}`}</span>
        {/* Q-13 결정 A: 외부 수신자 표시 겸 전환 단추. 켜면 서버가 일간 끔 · 보고용 · PDF로 맞춘다. */}
        <span className="seg" style={{ marginTop: 3 }} title={EXTERNAL_HINT}>
          <button type="button" aria-pressed={r.external} disabled={busy} aria-label="외부 수신자"
            onClick={() => { send({ external: !r.external }, r.external ? `${r.email} 을(를) 내부 수신자로 바꿨습니다.` : `${r.email} 을(를) 외부 수신자로 바꿨습니다 — 링크 없이 보고용 + PDF로 보냅니다.`); }}>외부</button>
        </span>
      </span></span>
      <span className="gc"><span className="seg"><button type="button" aria-pressed={r.daily} disabled={busy || r.external} title={r.external ? EXTERNAL_HINT : undefined} onClick={() => { send({ daily: !r.daily }); }} aria-label="일간 보고 받기">일간</button></span></span>
      <span className="gc"><span className="seg"><button type="button" aria-pressed={r.weekly} disabled={busy} onClick={() => { send({ weekly: !r.weekly }); }} aria-label="주간 보고 받기">주간</button></span></span>
      <span className="gc"><Seg label="주간 보기" value={r.view} disabled={busy || r.external} onPick={(view) => { send({ view }); }} options={[{ value: 'int', label: '팀장용' }, { value: 'ext', label: '보고용' }]} /></span>
      <span className="gc"><input type="checkbox" className="chk" checked={r.pdf} disabled={busy || r.external} onChange={() => { send({ pdf: !r.pdf }); }} aria-label="PDF 첨부" /></span>
      <span className="gc"><span className="tcell"><span className={last.cls}>{last.label}</span>{last.at && <span className="tid mono">{`${short(last.at)} · ${last.reportKey ?? ''}`}</span>}</span></span>
      <span className="gc"><span className={r.active ? 'vf v-pass' : 'vf v-none'}>{r.active ? '받는 중' : '중지'}</span></span>
      <span className="gc" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost sm" onClick={() => { setNote(onPreview(r) ? '' : '미리볼 보고서가 아직 없습니다.'); }}>미리보기</button>
        <BusyButton small variant="ghost" busy={test.busy} busyLabel="보내는 중…" onClick={() => { void test.save(); }}>테스트</BusyButton>
        <button type="button" className="btn ghost sm" disabled={busy || (!r.active && !r.daily && !r.weekly)}
          onClick={() => { send({ active: !r.active }, `${r.email}${r.active ? ' 발송을 중지했습니다.' : ' 발송을 다시 시작했습니다.'}`); }}>{r.active ? '중지' : '다시 받기'}</button>
        <BusyButton small variant="ghost" busy={remove.busy} busyLabel="삭제 중…" onClick={() => { void remove.save(); }}>삭제</BusyButton>
        {note && <span className="fhint" role="status">{note}</span>}
      </span>
      {patch.conflictModal}{remove.conflictModal}
    </div>
  );
}

function AddRecipient({ existing, refresh }: { existing: readonly Recipient[]; refresh: () => void }) {
  const { client } = useApi();
  const notify = useNotice();
  const [form, setForm] = useState<RecipientForm>(BLANK_RECIPIENT);
  const [error, setError] = useState('');
  const report = useContext(DirtyContext);
  const dirty = form.email !== '' || form.name !== '';
  useEffect(() => { report('mail-recipient-add', dirty); }, [report, dirty]);
  useEffect(() => () => { report('mail-recipient-add', false); }, [report]);
  const set = (p: Partial<RecipientForm>) => { setForm((f) => ({ ...f, ...p })); setError(''); };
  const add = useSave<ResponseOf<'addRecipient'>, RecipientForm>({
    target: '받는 사람 추가',
    request: () => ({ ...form, email: form.email.trim().toLowerCase(), name: form.name.trim() }),
    run: ({ payload, idempotencyKey }) => client.call('addRecipient', { body: payload, idempotencyKey }),
    onSuccess: (row) => { setForm(BLANK_RECIPIENT); refresh(); setError(''); notify(`${row.email} 을(를) 수신자로 등록했습니다.`); },
    onFieldErrors: (errors) => { if (errors[0]) setError(errors[0].message); },
    onRejected: (e) => { setError(e.code === 'RECIPIENT_DUPLICATE' ? '이미 등록된 주소입니다.' : (e.body?.error.message ?? '추가하지 못했습니다.')); },
  });
  return (
    <>
      <h3 style={{ margin: '0 0 6px', fontSize: 'var(--fs-md, 14px)' }}>받는 사람 추가</h3>
      <div className="form">
        <Row label={<>이메일 주소 <span className="req">*</span></>}><input className="inp" type="email" aria-label="이메일 주소" value={form.email} onChange={(e) => { set({ email: e.target.value }); }} placeholder="name@example.com" style={{ maxWidth: 360 }} /></Row>
        <Row label="이름 · 메모"><input className="inp" aria-label="이름 · 메모" value={form.name} onChange={(e) => { set({ name: e.target.value }); }} placeholder="예: 상급자 (주간보고)" style={{ maxWidth: 360 }} /></Row>
        <Row label={<>받을 보고서 <span className="req">*</span></>}>
          <div className="seg" role="group" aria-label="받을 보고서">
            <button type="button" aria-pressed={form.daily} disabled={form.external} onClick={() => { set({ daily: !form.daily }); }}>일간 (매일 07:00)</button>
            <button type="button" aria-pressed={form.weekly} onClick={() => { set({ weekly: !form.weekly }); }}>주간 (월 07:00)</button>
          </div>
          <span className="fhint">둘 다 고를 수 있습니다.</span>
        </Row>
        <Row label="주간 보고서 보기">
          <Seg label="주간 보고서 보기" value={form.view} disabled={form.external} onPick={(view) => { set({ view }); }} options={[{ value: 'int', label: VIEW_LABEL.int }, { value: 'ext', label: VIEW_LABEL.ext }]} />
          <span className="fhint">보고용은 Task ID · Agent 실행 세부를 빼고 진척 · 위험 · 다음 계획만 담습니다 — 상급자 · 외부 공유용.</span>
        </Row>
        <Row label="PDF 첨부"><label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" className="chk" checked={form.pdf} disabled={form.external} onChange={() => { set({ pdf: !form.pdf }); }} />본문 HTML과 함께 같은 보기의 PDF를 첨부</label></Row>
        {/* Q-13 결정 A: 원본에 없는 줄. 원본 칸 순서를 지키려고 맨 끝에 둔다. */}
        <Row label="외부 수신자">
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" className="chk" aria-label="외부 수신자" checked={form.external} onChange={() => { setForm((f) => withExternal(f, !f.external)); setError(''); }} />외부</label>
          <span className="fhint">{EXTERNAL_HINT}</span>
        </Row>
        {error && <p className="ferr" role="alert">{error}</p>}
        <div className="form-acts"><span className="sp" style={{ marginRight: 'auto' }}></span>
          <BusyButton busy={add.busy} busyLabel="추가 중…" onClick={() => {
            const problem = recipientError(form, existing);
            if (problem) { setError(problem); return; }
            void add.save();
          }}>받는 사람 추가</BusyButton>
        </div>
      </div>
    </>
  );
}

/* ---------------- 메일 서버(SMTP)(P L2543-2566) ---------------- */

function SmtpCard({ smtp, refresh }: { smtp: ReturnType<typeof useApiQuery<'getSmtp'>>; refresh: () => void }) {
  const { client } = useApi();
  const data = smtp.data;
  const [form, setForm] = useState<SmtpForm | null>(null);
  /**
   * 폼을 연 순간의 설정 버전(리뷰 지적 4). 저장은 이 버전으로 보낸다.
   * 왜: 열어 둔 동안 다른 탭이 저장해 화면 데이터가 새로 읽혀도, 내 편집은 옛 설정에서 시작했다. 최신 버전을 붙이면 서버의 충돌 검사를 지나쳐 남의 저장을 덮어쓴다.
   */
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState('');
  const report = useContext(DirtyContext);
  useEffect(() => { report('mail-smtp', form !== null); }, [report, form]);
  useEffect(() => () => { report('mail-smtp', false); }, [report]);
  const open = () => { if (data) { setForm({ host: data.host, port: String(data.port), sec: data.sec, from: data.from, user: data.user, pw: '' }); setBase(data.updatedAt); } setError(''); };
  const set = (p: Partial<SmtpForm>) => { setForm((f) => (f ? { ...f, ...p } : f)); setError(''); };
  const save = useSave<ResponseOf<'putSmtp'>, SmtpForm & { updatedAt: string | null }>({
    target: 'SMTP 설정 저장',
    request: () => ({ ...(form as SmtpForm), updatedAt: base }),
    run: ({ payload }) => client.call('putSmtp', { body: {
      updatedAt: payload.updatedAt, host: payload.host.trim(), port: Number(payload.port), sec: payload.sec, from: payload.from.trim(), user: payload.user.trim(),
      ...(payload.pw ? { password: payload.pw } : {}),
    } }),
    onSuccess: () => { setForm(null); refresh(); },
    successNotice: 'SMTP 설정을 저장했습니다. 「연결 확인」으로 확인하세요.',
    onFieldErrors: (errors) => { if (errors[0]) setError(errors[0].message); },
    onConflictReload: () => { setForm(null); refresh(); },
    // 「최신 내용에 내 변경 다시 적용」: 최신 설정을 읽어 그 버전 위에 내 폼 값을 저장한다(공통 useSave 경로).
    reapplyRequest: async ({ signal }) => {
      const latest = await client.call('getSmtp', { signal });
      return { ...(form as SmtpForm), updatedAt: latest.updatedAt };
    },
    mine: 'SMTP 설정 변경',
  });
  const check = useSave<ResponseOf<'checkSmtp'>>({
    target: 'SMTP 연결 확인',
    failTitle: '확인하지 못했습니다',
    run: ({ idempotencyKey }) => client.call('checkSmtp', { idempotencyKey }),
    onSuccess: () => { refresh(); },
  });
  const c = data?.check ?? null;
  const st = c ? (c.ok ? { l: '정상', cls: 'vf v-pass' } : { l: '실패', cls: 'vf v-fail' }) : { l: '확인 전', cls: 'vf v-none' };
  const configured = Boolean(data?.host);
  return (
    <section className="card" aria-labelledby="set-mail-smtp">
      <CardHead id="set-mail-smtp" title="메일 서버 (SMTP)">
        {configured && <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className={st.cls}>{st.l}</span><span className="mono muted">{c ? `확인 ${at(c.checkedAt)}` : '아직 연결을 확인하지 않았습니다'}</span></span>}
      </CardHead>
      <QueryGate query={smtp} label="메일 서버 설정" />
      {data && !form && configured && (
        <>
          <div className="kv" style={{ gridTemplateColumns: '130px minmax(0,1fr)', margin: '0 0 8px' }}>
            <span className="kv-l">서버</span><span className="kv-v mono">{`${data.host}:${String(data.port)} · ${data.sec}`}</span>
            <span className="kv-l">보내는 주소</span><span className="kv-v mono">{data.from || '—'}</span>
            <span className="kv-l">계정</span><span className="kv-v mono">{data.user || '(인증 없음)'}</span>
            <span className="kv-l">비밀번호</span><span className="kv-v">{data.pwSet ? '●●●●●●●● (저장됨 · 서버에 암호화 보관)' : '없음'}</span>
          </div>
          {c && !c.ok && c.error && <div className="banner danger" role="note"><div className="banner-b">{c.error}</div></div>}
          <div className="msg-acts">
            <BusyButton small variant="default" busy={check.busy} busyLabel="확인 중…" onClick={() => { void check.save(); }}>연결 확인</BusyButton>
            <button type="button" className="btn ghost sm" onClick={open}>수정</button>
          </div>
        </>
      )}
      {data && !form && !configured && (
        <div className="empty-box">
          <p className="empty" style={{ margin: '0 0 6px' }}>메일 서버가 설정되지 않았습니다.</p>
          <p className="fhint" style={{ margin: '0 0 8px' }}>보고서 메일은 Agent WBS 서버가 이 SMTP 계정으로 보냅니다. 사내 메일 서버, Gmail · Microsoft 365(앱 비밀번호) 등을 쓸 수 있습니다.</p>
          <button type="button" className="btn primary sm" onClick={open}>SMTP 설정</button>
        </div>
      )}
      {data && form && (
        <div className="form">
          <Row label={<>SMTP 서버 <span className="req">*</span></>}><input className="inp" aria-label="SMTP 서버" value={form.host} onChange={(e) => { set({ host: e.target.value }); }} placeholder="smtp.example.com" style={{ maxWidth: 300 }} /></Row>
          <Row label={<>보안 · 포트 <span className="req">*</span></>}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Seg label="보안 방식" value={form.sec} onPick={(sec) => { set({ sec, port: String(SECURITY.find((s) => s.value === sec)?.port ?? form.port) }); }}
                options={SECURITY.map((s) => ({ value: s.value as string, label: s.label }))} />
              <input className="inp mono" aria-label="포트" value={form.port} onChange={(e) => { set({ port: e.target.value }); }} style={{ width: 90 }} />
            </div>
          </Row>
          <Row label={<>보내는 주소 <span className="req">*</span></>}><input className="inp" aria-label="보내는 주소" value={form.from} onChange={(e) => { set({ from: e.target.value }); }} placeholder="Agent WBS <agent-wbs@example.com>" style={{ maxWidth: 360 }} /></Row>
          <Row label="계정"><input className="inp" aria-label="계정" value={form.user} onChange={(e) => { set({ user: e.target.value }); }} placeholder="비워 두면 인증 없이 보냄 (사내 릴레이)" style={{ maxWidth: 300 }} /></Row>
          <Row label="비밀번호">
            <input className="inp" type="password" aria-label="비밀번호" autoComplete="new-password" value={form.pw} onChange={(e) => { set({ pw: e.target.value }); }} style={{ maxWidth: 300 }} />
            <span className="fhint">{data.pwSet ? '비워 두면 저장된 비밀번호를 그대로 씁니다.' : 'Gmail · Microsoft 365는 계정 비밀번호 대신 앱 비밀번호를 쓰세요.'} 비밀번호는 서버에 암호화해 저장하고 화면 · API 응답 · 로그에 다시 내보내지 않습니다.</span>
          </Row>
          {error && <p className="ferr" role="alert">{error}</p>}
          <div className="form-acts"><span style={{ marginRight: 'auto' }}></span>
            <button type="button" className="btn" onClick={() => { setForm(null); setError(''); }}>취소</button>
            <BusyButton busy={save.busy} busyLabel="저장 중…" onClick={() => {
              const problem = smtpError(form, data.pwSet);
              if (problem) { setError(problem); return; }
              void save.save();
            }}>저장</BusyButton>
          </div>
        </div>
      )}
      {save.conflictModal}
    </section>
  );
}

/* ---------------- 발송 기록(P L2567-2580) ---------------- */

function LogCard({ log, recipients, reports, onPreview, refresh }: {
  log: ReturnType<typeof useAllPages<'listMailLog'>>; recipients: readonly Recipient[]; reports: readonly { id: string; kind: string }[];
  onPreview: (t: PreviewTarget) => void; refresh: () => void;
}) {
  const { client } = useApi();
  const [filter, setFilter] = useState<'all' | 'fail'>('all');
  const all = useMemo(() => log.data?.items ?? [], [log.data]);
  const failedAll = all.filter((l) => l.state === 'failed' || l.state === 'unknown' || l.state === 'retry_wait');
  const pending = all.filter((l) => l.pending);
  const shown = (filter === 'fail' ? failedAll : all).slice(0, LOG_LIMIT);
  const more = (filter === 'fail' ? failedAll : all).length > LOG_LIMIT;
  const resendAll = useSave<ResponseOf<'resendFailedMail'>>({
    target: '실패 건 모두 다시 보내기',
    failTitle: '다시 보내지 못했습니다',
    run: ({ idempotencyKey }) => client.call('resendFailedMail', { idempotencyKey }),
    onSuccess: () => { refresh(); },
    onRejected: () => { refresh(); },
    successNotice: '실패한 메일을 다시 발송 대기열에 넣었습니다.',
  });
  const unknown = pending.filter((l) => l.state === 'unknown').length;
  return (
    <section className="card" aria-labelledby="set-mail-log">
      <CardHead id="set-mail-log" title="발송 기록">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Seg label="발송 기록 보기" value={filter} onPick={setFilter} options={[{ value: 'all', label: `전체 ${String(all.length)}` }, { value: 'fail', label: `실패만 ${String(failedAll.length)}` }]} />
        </span>
      </CardHead>
      {pending.length > 0 && (
        <div className="banner warn" role="note">
          <div className="banner-b" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ marginRight: 'auto' }}>
              {`발송 실패 후 아직 성공하지 못한 메일 ${String(pending.length)}건`} — 실패한 메일은 15분 후 1회 자동 재시도하고, 그래도 실패하면 여기에 남습니다.
              {unknown > 0 && <> 「수락 여부 불명」 {unknown}건은 받는 쪽에 이미 도착했을 수 있습니다 — 다시 보내면 두 번 받을 수 있으니 확인 후 보내세요.</>}
            </span>
            <BusyButton small variant="default" busy={resendAll.busy} busyLabel="보내는 중…" onClick={() => { void resendAll.save(); }}>실패 건 모두 다시 보내기</BusyButton>
          </div>
        </div>
      )}
      <QueryGate query={log} label="발송 기록" />
      {log.data && (
        <TableScroll minWidth={1040} label="발송 기록 표">
          <div className="gtb" style={{ margin: 0 }}>
            <div className="gtr h lrow"><span className="gc">시각</span><span className="gc">보고서</span><span className="gc">받는 사람</span><span className="gc">보기</span><span className="gc">결과</span><span className="gc">사유 · 오류</span><span className="gc"></span></div>
            {shown.length === 0 && <div className="gtr"><span className="gc muted">발송 기록이 없습니다. 보고서가 생성되면 구독자에게 보낸 결과가 여기에 남습니다.</span></div>}
            {shown.map((l) => (
              <LogRow key={l.id} l={l} canPreview={reports.some((r) => r.id === l.reportId)} refresh={refresh}
                onPreview={() => { const r = reports.find((x) => x.id === l.reportId); if (r) onPreview({ reportId: r.id, kind: r.kind, view: l.view, to: recipients.some((x) => x.id === l.recipientId) ? l.recipientId : null }); }} />
            ))}
          </div>
        </TableScroll>
      )}
      <p className="fhint" style={{ margin: '6px 0 0' }}>{more ? `최근 ${String(LOG_LIMIT)}건만 표시 ` : ''}보고서는 생성 시점 스냅샷이므로 다시 보내도 같은 내용이 갑니다. 발송 기록은 수신자를 삭제해도 남습니다.</p>
      {resendAll.conflictModal}
    </section>
  );
}

function LogRow({ l, canPreview, onPreview, refresh }: { l: MailLog; canPreview: boolean; onPreview: () => void; refresh: () => void }) {
  const { client } = useApi();
  const s = stateLabel(l.state);
  const resend = useSave<ResponseOf<'resendMail'>>({
    target: `${l.to} 다시 보내기`,
    failTitle: '다시 보내지 못했습니다',
    run: ({ idempotencyKey }) => client.call('resendMail', { params: { id: l.id }, idempotencyKey }),
    onSuccess: () => { refresh(); },
    onRejected: () => { refresh(); },
    successNotice: `${l.to} 에 다시 보내도록 대기열에 넣었습니다.`,
  });
  return (
    <div className="gtr lrow" data-testid={`mail-log-${l.id}`}>
      <span className="gc"><span className="tcell"><span className="mono">{at(l.at)}</span><span className="tid mono">{l.logKey}</span></span></span><span className="gc mono">{l.reportKey}</span><span className="gc mono" style={{ wordBreak: 'break-all' }}>{l.to}</span>
      <span className="gc">{VIEW_LABEL[l.view] + (l.pdf ? ' + PDF' : '')}{l.external && <> <span className="tag chg">외부</span></>}</span>
      <span className="gc"><span className={s.cls}>{s.label}</span></span>
      <span className="gc"><span className="tcell"><span>{l.reason}</span>{l.error && <span className="tid" style={{ color: 'var(--dg)' }}>{l.error}</span>}</span></span>
      <span className="gc" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {canPreview && <button type="button" className="btn ghost sm" onClick={onPreview}>메일 보기</button>}
        {l.pending && <BusyButton small variant="default" busy={resend.busy} busyLabel="보내는 중…" onClick={() => { void resend.save(); }}>다시 보내기</BusyButton>}
      </span>
    </div>
  );
}

/* ---------------- 메일 미리보기(P L2725-2741) ---------------- */

/** 실제 보낼 HTML을 서버에서 받아(G§8.5 「실제 발송과 같은 생성 함수」) 스크립트 없는 iframe(sandbox)에 보인다. */
export function MailPreview({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
  const [view, setView] = useState<'int' | 'ext'>(target.kind === 'daily' ? 'int' : target.view);
  const q = useApiQuery('previewReportMail', { params: { reportId: target.reportId }, query: { view, ...(target.to ? { to: target.to } : {}) } }, { topics: ['mail', 'report'] });
  const d = q.data;
  return (
    <Modal title="메일 미리보기" role="dialog" onCancel={onClose} style={{ width: 'min(860px,100%)' }}
      footer={<><span className="sp"></span><button type="button" className="btn" onClick={onClose}>닫기</button></>}>
      <QueryGate query={q} label="메일 미리보기" />
      {d && (
        <>
          <div className="kv" style={{ gridTemplateColumns: '90px minmax(0,1fr)', margin: '0 0 10px' }}>
            <span className="kv-l">보내는 사람</span><span className="kv-v mono">{d.from}</span>
            <span className="kv-l">받는 사람</span><span className="kv-v mono">{d.to}</span>
            <span className="kv-l">제목</span><span className="kv-v"><b>{d.subject}</b></span>
            <span className="kv-l">첨부</span><span className="kv-v mono">{`첨부: ${d.attachment ?? '없음'}`}</span>
          </div>
          {d.external && <div className="banner warn" role="note"><div className="banner-b"><b>외부 수신자</b> — 앱 링크 없이 보고용 본문과 PDF 첨부로 보냅니다.</div></div>}
          {target.kind !== 'daily' && !d.external && (
            <div style={{ marginBottom: 8 }}>
              <Seg label="메일 보기" value={view} onPick={setView} options={[{ value: 'int', label: VIEW_LABEL.int }, { value: 'ext', label: VIEW_LABEL.ext }]} />
            </div>
          )}
          <iframe className="mail-fr" title="메일 본문 미리보기" srcDoc={d.html} sandbox="" />
          <p className="fhint" style={{ margin: '8px 0 0' }}>실제 발송되는 HTML 본문입니다 — 표 레이아웃 · 인라인 스타일만 사용하고 외부 이미지 · 스크립트가 없습니다. 메일 앱이 웹 폰트를 지원하지 않으면 맑은 고딕 · Apple SD Gothic Neo로 표시됩니다.</p>
        </>
      )}
    </Modal>
  );
}
