/**
 * 체크리스트 탭(UI-03-05) — 원본 P L1269–1301, 동작 P L5342–5353.
 * - 완료 토글·항목 추가는 바로 저장한다. 빈 내용은 「추가」가 꺼져 있다(원본 clAddDisabled).
 * - 필수 항목이 남아 있으면 Gate 미통과 띠를 보이고, 서버도 자동 완료하지 않는다.
 */
import { useRef, useState } from 'react';
import { BusyButton } from '../../../shared/ui/BusyButton.tsx';
import type { TaskDetailData } from '../labels.ts';
import { useApiClient, useTaskSave } from '../useTaskData.ts';

const GRID = '56px 100px minmax(180px,1fr) 70px 150px 170px 120px';

export function ChecklistTab({ task: t }: { task: TaskDetailData }) {
  const client = useApiClient();
  const items = t.checklistItems;
  const tot = items.length;
  const done = items.filter((c) => c.done).length;
  const reqLeft = items.filter((c) => c.required && !c.done).length;
  const [text, setText] = useState('');
  const [method, setMethod] = useState('');
  const [req, setReq] = useState(true);
  const toggling = useRef<{ key: string; done: boolean } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [mine, setMine] = useState('');
  const toggle = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 체크리스트 완료 표시`,
    mine,
    request: () => toggling.current ?? { key: '', done: false },
    run: ({ updatedAt, payload: x }) => client.call('updateChecklistItem', { params: { taskKey: t.taskKey, itemKey: x.key }, body: { updatedAt, done: x.done } }),
    onSuccess: () => { setBusyKey(null); },
    onRejected: () => { setBusyKey(null); },
  });
  const add = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 체크리스트 항목 추가`,
    mine: `항목 추가: ${text.trim()}`,
    request: () => ({ content: text.trim(), required: req, method: method.trim() }),
    run: ({ idempotencyKey, updatedAt, payload: x }) => client.call('addChecklistItem', { params: { taskKey: t.taskKey }, body: { updatedAt, content: x.content, required: x.required, ...(x.method ? { verifyMethod: x.method } : {}) }, idempotencyKey }),
    onSuccess: () => { setText(''); setMethod(''); },
    successNotice: '체크리스트 항목을 추가했습니다.',
  });
  return (
    <div className="pane">
      <div className="pane-h"><div className="pane-hl"><h3>체크리스트</h3><span className="muted">{tot ? `${String(done)}/${String(tot)}` : '0/0'} 완료</span></div></div>
      {(!tot || reqLeft > 0) && <div className="banner warn" style={{ margin: '0 0 14px' }}><div className="banner-b"><b>Completion Gate 미통과</b> — {!tot ? '체크리스트가 등록되지 않았습니다.' : `필수 항목 ${String(reqLeft)}건이 미완료라 완료 처리할 수 없습니다.`}</div></div>}
      {tot > 0 && !reqLeft && <div className="banner ok" style={{ margin: '0 0 14px' }}><div className="banner-b"><b>필수 항목 모두 완료</b> — Completion Gate의 체크리스트 조건을 충족했습니다.</div></div>}
      <div className="gtb" role="table" aria-label="체크리스트">
        <div className="gtr h" style={{ gridTemplateColumns: GRID }} role="row"><span className="gc">완료</span><span className="gc">항목 ID</span><span className="gc">체크 내용</span><span className="gc">구분</span><span className="gc">검증 방법</span><span className="gc">관련 Evidence</span><span className="gc">결과·비고</span></div>
        {items.map((ci) => (
          <div className={`gtr ${ci.done ? 'dim' : ''}`} key={ci.itemKey} style={{ gridTemplateColumns: GRID }} role="row">
            <span className="gc">
              {busyKey === ci.itemKey ? <span className="bspin" aria-label="저장 중" /> : (
                <input type="checkbox" className="chk" checked={ci.done} disabled={toggle.busy} aria-label={`${ci.itemKey} ${ci.content}${ci.done ? ' 완료됨' : ' 미완료'}`}
                  onChange={() => { toggling.current = { key: ci.itemKey, done: !ci.done }; setBusyKey(ci.itemKey); setMine(`${ci.itemKey} ${ci.done ? '미완료' : '완료'}`); void toggle.save().then((ok) => { if (!ok) setBusyKey(null); }); }} />
              )}
            </span>
            <span className="gc mono">{ci.itemKey}</span>
            <span className="gc">{ci.content}</span>
            <span className="gc"><span className={ci.required ? 'req' : 'opt'}>{ci.required ? '필수' : '선택'}</span></span>
            <span className="gc">{ci.verifyMethod || '—'}</span>
            <span className="gc mono">{ci.evidence || '—'}</span>
            <span className="gc muted">{ci.note ?? ''}</span>
          </div>
        ))}
        {!tot && <div className="gtr"><span className="gc muted">등록된 체크리스트가 없습니다. 아래에서 항목을 추가하세요.</span></div>}
      </div>
      <div className="addbox">
        <h4>항목 추가</h4>
        <div className="addbox-r">
          <label className="sr" htmlFor="cl-text">체크 내용</label>
          <input id="cl-text" className="inp" style={{ flex: 2, minWidth: 240 }} placeholder="체크 내용 (필수)" value={text} onChange={(e) => { setText(e.target.value); }} />
          <label className="sr" htmlFor="cl-m">검증 방법</label>
          <input id="cl-m" className="inp" style={{ flex: 1, minWidth: 180 }} placeholder="검증 방법 (선택)" value={method} onChange={(e) => { setMethod(e.target.value); }} />
          <div className="seg" role="group" aria-label="필수 여부">{([[true, '필수'], [false, '선택']] as const).map(([v, l]) => <button type="button" key={l} aria-pressed={req === v} onClick={() => { setReq(v); }}>{l}</button>)}</div>
          <BusyButton small busy={add.busy} busyLabel="추가 중…" disabled={!text.trim()} onClick={() => { void add.save(); }}>추가</BusyButton>
        </div>
      </div>
      {toggle.conflictModal}
      {add.conflictModal}
    </div>
  );
}
