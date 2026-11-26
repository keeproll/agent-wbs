import { useState } from 'react';
import { useApi } from '../../../shared/api/ApiProvider.tsx';
import type { ResponseOf } from '../../../shared/api/contract.ts';
import { useApiQuery } from '../../../shared/api/queries.ts';
import { useSave } from '../../../shared/state/useSave.tsx';
import { BusyButton } from '../../../shared/ui/BusyButton.tsx';
import { Modal } from '../../../shared/ui/Modal.tsx';
import { useSettingForm } from '../useSettingForm.tsx';
import { CardHead, QueryGate, Row, useSettingQuery } from '../ui.tsx';

export const ERRORS = {
  token_invalid: '토큰 오류(401) — BotFather에서 토큰을 확인하세요.', chat_not_found: '대화 없음(400) — Chat ID와 봇의 시작 여부를 확인하세요.',
  forbidden: '전송 권한 없음 · 봇 차단(403) — 차단 해제 또는 그룹 재초대 후 테스트하세요.',
  network: '통신 실패 — 네트워크를 확인하고 다시 시도하세요.', rate_limited: '요청 제한(429) · 재시도 대기 — 서버가 다시 보냅니다.',
  webhook_in_use: 'Webhook 사용 중 — 자동 해제하지 않습니다. Chat ID를 직접 입력하세요.', chat_migrated: '수신 대상 변경 필요 — 새 Chat ID를 입력하고 테스트 후 저장하세요.',
};
interface Form { enabled: boolean; targetName: string; chatId: string; replace: boolean; botToken: string }
const identity = (f: Form) => JSON.stringify([f.replace ? f.botToken : null, f.chatId]);
const tokenIdentity = (f: Form) => f.replace ? f.botToken : '';

export function Connection() {
  const { client } = useApi();
  const q = useSettingQuery('getTelegram', 'Telegram 연결 설정', ['notify', 'settings']);
  const alerts = useApiQuery('listAlerts', {}, { topics: ['alert', 'notify'] });
  const connectionAlert = alerts.data?.items.find(alert => alert.key === 'telegram-connection');
  const form = useSettingForm({ ...q, id: 'telegram', label: 'Telegram 연결 설정',
    toForm: (data): Form => ({ enabled: data.enabled, targetName: data.targetName, chatId: data.chatId ?? '', replace: !data.tokenSet, botToken: '' }),
    send: (f, updatedAt) => client.call('putTelegram', { body: { enabled: f.enabled, chatId: f.chatId, targetName: f.targetName, updatedAt, ...(f.replace ? { botToken: f.botToken } : {}) } }),
    check: f => f.replace && !/^[0-9]{6,12}:[A-Za-z0-9_-]{20,}$/.test(f.botToken) ? '빈 값이나 마스킹 값 대신 새 Bot Token을 입력하세요.'
      : !/^-?\d{5,20}$/.test(f.chatId) ? 'Chat ID는 5~20자리 숫자입니다. 그룹은 음수 그대로 입력하세요. 전화번호와 @사용자명은 쓸 수 없습니다.'
        : !f.targetName.trim() ? '수신 대상 이름을 입력하세요.' : null,
  });
  const [botResult, setBot] = useState<{ key: string; result: ResponseOf<'checkTelegramBot'> } | null>(null);
  const [testResult, setTest] = useState<{ key: string; result: ResponseOf<'testTelegram'> } | null>(null);
  const [finding, setFinding] = useState(false);
  const trackedTest = useApiQuery('getTelegram', { query: testResult?.result.testId ? { testId: testResult.result.testId } : {} }, {
    enabled: !!testResult?.result.testId, topics: ['notify'], keepPrevious: false,
  });
  const f = form.form;
  const tokenBody = () => f?.replace ? { botToken: f.botToken } : {};
  const bot = useSave({ target: '봇 확인', request: () => ({ body: tokenBody(), key: f ? tokenIdentity(f) : '' }),
    run: ({ payload, idempotencyKey }) => client.call('checkTelegramBot', { body: payload.body, idempotencyKey }),
    onSuccess: (result, payload) => { setBot({ key: payload.key, result }); },
  });
  const test = useSave({ target: '테스트 알림', request: () => ({ body: { ...tokenBody(), chatId: f?.chatId ?? '', targetName: f?.targetName ?? '' }, key: f ? identity(f) : '' }),
    run: ({ payload, idempotencyKey }) => client.call('testTelegram', { body: payload.body, idempotencyKey }),
    onSuccess: (result, payload) => {
      const completed = { key: payload.key, result }; setTest(completed);
      void q.query.refetch().then(() => {
        if (payload.body.botToken === undefined && payload.body.chatId === q.query.data?.chatId) setTest(current => current === completed ? null : current);
      });
    },
  });
  const liveTest = f && testResult?.key === identity(f) ? trackedTest.data?.test ?? testResult.result : null;
  const savedMatch = f && !f.replace && f.chatId === q.query.data?.chatId;
  const success = liveTest?.ok ?? (savedMatch ? q.query.data?.test?.ok : false);
  const liveBot = f && botResult?.key === tokenIdentity(f) ? botResult.result : null;
  const error = liveTest?.error ?? liveBot?.error ?? (savedMatch ? q.query.data?.test?.error : null);
  const shownBot = liveBot?.bot ?? (!f?.replace ? q.query.data?.bot : null);
  const changeIdentity = (change: Partial<Form>) => {
    form.edit(current => ({ ...current, ...change, enabled: false }));
    setTest(null);
    if ('botToken' in change || 'replace' in change) setBot(null);
  };
  return <section className="card" aria-labelledby="tg-connect">
    <CardHead id="tg-connect" title="Telegram 연결 설정"><span className={error || connectionAlert ? 'vf v-fail' : success ? 'vf v-pass' : 'vf v-blk'}>{error || connectionAlert ? '연결 오류' : success ? '테스트 성공' : q.query.data?.tokenSet ? '수신 대상 테스트 필요' : '설정 전'}</span></CardHead>
    <QueryGate query={q.query} label="Telegram 연결 설정" />{form.restoreOffer}
    <p className="fhint">봇 1개 → 수신 대화 1개입니다. 서버가 대기열로 보내므로 브라우저를 닫아도 발송합니다. 전송 실패는 Task · Agent 실행에 영향을 주지 않습니다. 승인 · 조치는 WBS 화면에서 합니다.</p>
    {f && <div className="form">
      {(error || connectionAlert) && <div className="banner danger" role="alert"><div className="banner-b">{error ? ERRORS[error] : connectionAlert?.text}</div></div>}
      <Row label={<label htmlFor="tg-token">Bot Token <span className="req" aria-hidden="true">*</span></label>}>
        {f.replace ? <div className="notify-controls"><input id="tg-token" aria-label="Bot Token" className="inp mono" type="password" autoComplete="new-password" value={f.botToken} onChange={e => { changeIdentity({ botToken: e.target.value }); }} />
          {q.query.data?.tokenSet && <button type="button" className="btn sm" onClick={() => { changeIdentity({ replace: false, botToken: '' }); }}>교체 취소</button>}</div>
          : <div className="notify-controls"><span>●●●● 등록됨 (끝 {q.query.data?.tokenLast4})</span><button type="button" className="btn sm" onClick={() => { changeIdentity({ replace: true, botToken: '' }); }}>토큰 교체</button></div>}
        <span className="fhint">BotFather에서 받은 토큰입니다. 저장 후에는 다시 보여 주지 않고 끝 4자리만 표시합니다. 서버에만 암호화하며 브라우저 저장소 · 로그 · 이력에 남기지 않습니다. 노출되면 BotFather에서 즉시 폐기(/revoke)하세요.</span>
      </Row>
      <Row label="봇"><div className="notify-controls"><span>{shownBot ? `@${shownBot.username}` : '봇 확인 필요'}</span>
        <BusyButton small variant="default" busy={bot.busy} busyLabel="봇 확인 중…" onClick={() => { void bot.save(); }}>봇 확인</BusyButton></div>
        {liveBot?.error && <span className="ferr" role="alert">{ERRORS[liveBot.error]}</span>}
        <span className="fhint">토큰이 유효한지만 확인합니다 (getMe). 수신 대화는 테스트 알림으로 확인합니다.</span>
      </Row>
      <Row label={<label htmlFor="tg-target">수신 대상 이름 <span className="req" aria-hidden="true">*</span></label>}><input id="tg-target" aria-label="수신 대상 이름" className="inp" value={f.targetName} onChange={e => { form.edit(current => ({ ...current, targetName: e.target.value })); }} /><span className="fhint">화면 · 이력 표시용 이름 — 바꿔도 테스트 결과는 유지됩니다.</span></Row>
      <Row label={<label htmlFor="tg-chat">Chat ID <span className="req" aria-hidden="true">*</span></label>}><div className="notify-controls"><input id="tg-chat" aria-label="Chat ID" className="inp mono" value={f.chatId} onChange={e => { changeIdentity({ chatId: e.target.value }); }} /><button type="button" className="btn sm" onClick={() => { setFinding(true); }}>수신 대상 찾기</button></div>
        <span className="fhint">5~20자리 숫자입니다. 개인은 양수, 그룹은 음수 그대로 입력합니다. 전화번호 · @사용자명은 쓸 수 없습니다.</span>
      </Row>
      <Row label="수신 대화"><span>{q.query.data?.chat?.chatId === f.chatId ? q.query.data.chat.title : '테스트 알림으로 확인하세요.'}</span></Row>
      <Row label="테스트 알림"><div className="notify-controls"><BusyButton small variant="default" busy={test.busy} busyLabel="테스트 전송 중…" onClick={() => { void test.save(); }}>테스트 알림 보내기</BusyButton>
        {success && <span className="vf v-pass">전송 요청 수락 — 실제 도착은 Telegram 앱에서 확인</span>}</div><span className="fhint">저장 전 현재 입력값으로 보냅니다. Bot Token · Chat ID를 바꾸면 다시 테스트해야 합니다.</span></Row>
      <Row label="알림 사용"><div className="seg" role="group" aria-label="알림 사용"><button type="button" aria-pressed={f.enabled} disabled={!success} onClick={() => { form.edit(current => ({ ...current, enabled: true })); }}>켜기</button><button type="button" aria-pressed={!f.enabled} onClick={() => { form.edit(current => ({ ...current, enabled: false })); }}>끄기</button></div></Row>
      {form.footer}
      {finding && <FindChats token={tokenBody()} onClose={() => { setFinding(false); }} onPick={chat => { changeIdentity({ chatId: chat.chatId, targetName: chat.title }); setFinding(false); }} />}
    </div>}
    {bot.conflictModal}{test.conflictModal}
  </section>;
}

function FindChats({ token, onClose, onPick }: { token: { botToken?: string }; onClose: () => void; onPick: (chat: ResponseOf<'findTelegramChats'>['candidates'][number]) => void }) {
  const { client } = useApi();
  const [result, setResult] = useState<ResponseOf<'findTelegramChats'> | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const find = useSave({ target: '최근 대화 조회', request: () => token,
    run: ({ payload, idempotencyKey }) => client.call('findTelegramChats', { body: payload, idempotencyKey }),
    onSuccess: value => { setResult(value); setPick(null); },
  });
  return <Modal role="dialog" title="수신 대상 찾기" onCancel={onClose} footer={<><button type="button" className="btn" onClick={onClose}>취소</button><button type="button" className="btn primary" disabled={pick === null} onClick={() => { const selected = result?.candidates.find(c => c.chatId === pick); if (selected) onPick(selected); }}>이 대화 선택</button></>}>
    <ol className="tg-steps"><li>개인 대화: 봇을 열고 /start를 보내세요.</li><li>그룹: 봇을 초대한 뒤 /start@봇이름을 보내세요.</li><li>최근 대화를 조회하고 직접 선택하세요. 선택만으로 저장하지 않습니다.</li></ol>
    <BusyButton small variant="default" busy={find.busy} busyLabel="조회 중…" onClick={() => { void find.save(); }}>최근 대화 조회</BusyButton>
    {result?.error && <p role="alert" className="ferr">{ERRORS[result.error]}</p>}
    {result?.ok && result.candidates.length === 0 && <p>최근 대화가 없습니다. 봇에서 시작을 누른 뒤 다시 조회하세요. Chat ID를 직접 입력할 수도 있습니다.</p>}
    {result?.candidates.map(c => <label key={c.chatId} className={`tg-cand${pick === c.chatId ? ' on' : ''}`}><input type="radio" name="telegram-chat" checked={pick === c.chatId} onChange={() => { setPick(c.chatId); }} /><span>{c.title} · {c.type} · {c.chatId}</span></label>)}
    {find.conflictModal}
  </Modal>;
}
