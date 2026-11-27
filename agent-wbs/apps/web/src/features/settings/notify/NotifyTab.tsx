import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../../shared/api/ApiProvider.tsx';
import type { ResponseOf } from '../../../shared/api/contract.ts';
import { useApiQuery } from '../../../shared/api/queries.ts';
import { useRefreshError } from '../../../shared/layout/MenuScreen.tsx';
import { formatDateTime } from '../../../shared/format.ts';
import { TableScroll } from '../../../shared/ui/TableScroll.tsx';
import { CardHead, QueryGate, Row, useSettingQuery } from '../ui.tsx';
import { useSettingForm } from '../useSettingForm.tsx';
import { Connection } from './Connection.tsx';
import './notify.css';

const EVENTS = {
  done: ['Task 완료', 'WBS 최종 완료 판정 — Completion Gate 통과 · 통합 확인 통과 · PR 병합 후. Agent 시도 완료나 Runner 종료 코드 0은 해당 안 됨'],
  fail: ['Task 실패', '검증(QA) FAIL 확정 · 실행 시도 실패가 재시도 한도 초과 — 시도마다 보내지 않음'],
  admin: ['관리자 개입 필요', '사람이 조치해야 진행되는 상황 — CLI 로그인 만료 · GitHub 인증 실패 · 하위 Agent 관측 미확인(보유) · 입력 자료 변경 확인 대기'],
  approve: ['승인 요청', 'Change Proposal 승인 대기 · 기술 결정 승인 대기 · 초기 WBS 승인'],
  buildOk: ['빌드 성공', '② 통합 확인 · ④ 배포 확인 통과 (① Task 검사는 제외). 빌드 성공 ≠ 테스트 성공 — 통과한 단계를 명시'],
  buildFail: ['빌드 실패', '② 통합 확인 · ③ 야간 점검 · ④ 배포 확인 실패 — 실패 단계(빌드 / 테스트 / E2E / 기동)를 명시'],
} as const;
type Event = keyof typeof EVENTS;
const keys = Object.keys(EVENTS) as Event[];
const STATES = { queued: '대기', sending: '대기', accepted: '전송 요청 수락', retry_wait: '재시도 대기', failed: '실패', unknown: '실패 — 수락 여부 불명' };

export function NotifyTab({ projectId, projectName }: { projectId: string | null; projectName: string }) {
  return <>
    <Connection />
    {projectId ? <Rules projectId={projectId} projectName={projectName} /> : <section className="card"><p>프로젝트를 등록하면 알림 규칙과 메시지 미리보기를 사용할 수 있습니다.</p></section>}
    <AppUrl />
    {projectId && <History projectId={projectId} />}
  </>;
}

function Rules({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { client } = useApi();
  const q = useSettingQuery('getNotifyRules', '알림 규칙', ['notify'], { params: { projectId } });
  const form = useSettingForm({ ...q, id: `notify-rules:${projectId}`, label: '알림 규칙', toForm: data => data,
    send: (f, updatedAt) => client.call('putNotifyRules', { params: { projectId }, body: { ...f, updatedAt } }),
  });
  const [event, setEvent] = useState<Event>('done');
  const preview = useApiQuery('previewNotify', { params: { projectId }, query: { event } }, { topics: ['settings', 'notify'], keepPrevious: false });
  useRefreshError(preview, '메시지 미리보기');
  return <>
    <section className="card" aria-labelledby="tg-rules"><CardHead id="tg-rules" title="알림 규칙" />
      <p className="fhint">현재 프로젝트: {projectName}</p><QueryGate query={q.query} label="알림 규칙" />{form.restoreOffer}
      {form.form && <div className="tg-rules">{keys.map(key => <label className="tg-rule" key={key}><input type="checkbox" className="chk" checked={form.form?.[key] ?? false} onChange={e => { const checked = e.target.checked; form.edit(current => ({ ...current, [key]: checked })); }} /><span className="tcell"><b>{EVENTS[key][0]}</b><span className="tid">{EVENTS[key][1]}</span></span></label>)}</div>}
      <p className="fhint">확정된 상태 전이에서만 보냅니다. 같은 대상 · 이벤트 · 원인은 해소될 때까지 1번만 보냅니다. 다시 생기면 「중복 생략 n회」로 남깁니다. 보고서 요약은 메일로 보냅니다.</p>{form.footer}
    </section>
    <section className="card" aria-labelledby="tg-preview"><CardHead id="tg-preview" title="메시지 미리보기"><div className="seg" role="group" aria-label="미리보기 이벤트">{keys.map(key => <button type="button" key={key} aria-pressed={event === key} onClick={() => { setEvent(key); }}>{EVENTS[key][0]}</button>)}</div></CardHead>
      {form.form && !form.form[event] && <div className="banner warn"><div className="banner-b">현재 알림 규칙에서 꺼져 있어 이 이벤트는 보내지 않습니다.</div></div>}
      <QueryGate query={preview} label="메시지 미리보기" />{preview.data && <div className="tg-chat"><div className="tg-bubble">{preview.data.text}</div></div>}
      <p className="fhint">일반 텍스트만 보냅니다. 확인되지 않은 원인은 「미확정」으로 표시합니다.</p>
    </section>
  </>;
}

function AppUrl() {
  const { client } = useApi();
  const q = useSettingQuery('getAppUrl', 'Agent WBS 접속 주소', ['settings', 'notify']);
  const form = useSettingForm({ ...q, id: 'app-url', label: 'Agent WBS 접속 주소', toForm: data => ({ appUrl: data.appUrl ?? '' }),
    send: (f, updatedAt) => client.call('putAppUrl', { body: { appUrl: f.appUrl || null, updatedAt } }),
    check: ({ appUrl: value }) => {
      if (!value) return null;
      try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return null; } catch { /* 아래 안내로 표시한다. */ }
      return '사용자 정보·질의·조각이 없는 HTTP 또는 HTTPS 주소를 입력하세요.';
    },
  });
  let local = false;
  try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(form.form?.appUrl ?? '').hostname); } catch { /* 입력 중에는 형식 안내만 표시한다. */ }
  return <section className="card" aria-labelledby="tg-url"><CardHead id="tg-url" title="Agent WBS 접속 주소"><span className="muted">메일 · Telegram 링크 공용</span></CardHead>
    <QueryGate query={q.query} label="Agent WBS 접속 주소" />{form.restoreOffer}
    {form.form !== undefined && <div className="form"><Row label={<label htmlFor="tg-app-url">접속 주소</label>}><div className="notify-controls notify-url"><input id="tg-app-url" className="inp mono" value={form.form.appUrl} onChange={e => { const value = e.target.value; form.edit(() => ({ appUrl: value })); }} placeholder="예: http://192.168.0.10:3100" />{form.footer}{!form.dirty && !form.busy && <button type="button" className="btn sm" disabled>저장</button>}</div>
      {local && <div className="banner warn"><div className="banner-b">이 PC에서만 열림 — 휴대폰에서 열 수 없음. 같은 네트워크의 PC 주소를 쓰세요.</div></div>}
      {!form.form.appUrl && <span className="fhint">비어 있으면 메일 · Telegram 메시지에 「WBS에서 확인」 링크를 넣지 않습니다.</span>}</Row></div>}
  </section>;
}

function History({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<'biz' | 'test' | undefined>();
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const topics = ['notify', 'task', 'runner', 'ci', 'planning', 'proposal', 'design', 'project', 'settings'] as const;
  const query = useApiQuery('listNotifyLog', { params: { projectId }, query: { ...(kind ? { kind } : {}), ...(cursor ? { cursor } : {}) } }, { topics });
  const detail = useApiQuery('getNotifyLog', { params: { projectId, id: selected ?? '' } }, { enabled: selected !== null, topics, keepPrevious: false });
  useRefreshError(query, '전송 이력'); useRefreshError(detail, '전송 이력 상세');
  const row = (log: ResponseOf<'listNotifyLog'>['items'][number]) => <tr key={log.id}>
    <td className="mono">{formatDateTime(log.at)}</td><td>{log.projectName}</td><td><button type="button" className="btn ghost sm" onClick={() => { setSelected(log.id); }}>{log.target}</button></td>
    <td>{log.event ? EVENTS[log.event][0] : '테스트'}</td><td>{log.targetName} ({log.chatId})</td>
    <td><span className={log.state === 'accepted' ? 'vf v-pass' : ['failed', 'unknown'].includes(log.state) ? 'vf v-fail' : 'vf v-blk'}>{STATES[log.state]}</span>{log.duplicates > 0 && <div className="tid">중복 생략 {log.duplicates}회</div>}</td><td>{log.attempts}</td><td>{log.error ?? '—'}</td><td>{log.kind === 'biz' ? '업무' : '테스트'}</td>
  </tr>;
  return <section className="card" aria-labelledby="tg-history"><CardHead id="tg-history" title="전송 이력"><div className="seg" role="group" aria-label="이력 구분">{([undefined, 'biz', 'test'] as const).map((value, index) => <button key={index} type="button" aria-pressed={kind === value} onClick={() => { setKind(value); setCursor(undefined); setSelected(null); }}>{['전체', '업무', '테스트'][index]}</button>)}</div></CardHead>
    <QueryGate query={query} label="전송 이력" />
    {query.data && query.data.items.length === 0 ? <p className="muted">{kind ? '조건에 맞는 전송 이력이 없습니다. 전체 구분으로 확인해 보세요.' : '전송 이력이 없습니다. 연결을 설정하고 테스트 알림을 보내 보세요.'}</p> : query.data && <TableScroll minWidth={1050} label="Telegram 전송 이력 표"><table className="notify-table"><thead><tr>{['발생 시각', '프로젝트', '대상 Task · 빌드', '이벤트', '수신 대상', '전송 상태', '시도', '오류 요약', '구분'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{query.data.items.map(row)}</tbody></table></TableScroll>}
    {cursor && <button type="button" className="btn sm" onClick={() => { setCursor(undefined); }}>처음으로</button>}
    {query.data?.nextCursor && <button type="button" className="btn sm" onClick={() => { setCursor(query.data?.nextCursor ?? undefined); }}>다음</button>}
    {selected && <div className="tg-det"><QueryGate query={detail} label="전송 이력 상세" /><div className="dp-h"><h3>전송 상세</h3><div className="notify-controls">{detail.data?.path && <Link className="btn sm" to={detail.data.path}>WBS에서 확인</Link>}<button type="button" className="btn ghost sm" onClick={() => { setSelected(null); }}>닫기</button></div></div>{detail.data && <div className="tg-chat"><div className="tg-bubble">{detail.data.message}</div></div>}</div>}
    <p className="fhint">전송 요청 수락은 Telegram API가 요청을 받았다는 뜻입니다. 도착 · 읽음 · 승인이 아닙니다. 초기화하면 이력은 항상 삭제됩니다.</p>
  </section>;
}
