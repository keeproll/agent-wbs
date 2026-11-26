/**
 * 체크리스트 탭(UI-03-05) — 원본 P L1269–1301, 동작 P L5342–5353.
 * - 완료 토글·항목 추가는 바로 저장한다. 빈 내용은 「추가」가 꺼져 있다(원본 clAddDisabled).
 * - 필수 항목이 남아 있으면 Gate 미통과 띠를 보이고, 서버도 자동 완료하지 않는다.
 * - 새 항목 입력도 편집 자리(edit-slot)에 올린다(리뷰 R5). 그래서 탭·Task·메뉴 이동은 확인을 묻고,
 *   로그인이 끊기면 초안을 보관했다가 복원한다. 추가가 성공해도 그 사이 더 입력한 내용은 지우지 않는다.
 */
import { useEffect, useRef, useState } from 'react';
import { useEditSlot } from '../edit-slot.tsx';
import { BusyButton } from '../../../shared/ui/BusyButton.tsx';
import type { TaskDetailData } from '../labels.ts';
import { useApiClient, useTaskSave } from '../useTaskData.ts';

const ADD_SLOT = 'checklist-add';
/** 새 항목 입력 초안(세션 만료 보관용) */
interface Draft { text: string; method: string; req: boolean }
const GRID = '56px 100px minmax(180px,1fr) 70px 150px 170px 120px';

export function ChecklistTab({ task: t }: { task: TaskDetailData }) {
  const client = useApiClient();
  const items = t.checklistItems;
  const tot = items.length;
  const done = items.filter((c) => c.done).length;
  const reqLeft = items.filter((c) => c.required && !c.done).length;
  const slot = useEditSlot();
  const restored = slot.current === ADD_SLOT ? (slot.restored as Draft | null) : null;
  const [text, setText] = useState(restored?.text ?? '');
  const [method, setMethod] = useState(restored?.method ?? '');
  const [req, setReq] = useState(restored?.req ?? true);
  useEffect(() => { if (slot.current === ADD_SLOT) slot.report({ text, method, req } satisfies Draft); }, [text, method, req, slot]);
  /** 입력이 생기면 편집 자리를 잡고 dirty, 모두 비면 놓는다(이벤트에서 부른다). */
  const track = (nextText: string, nextMethod: string) => {
    const has = nextText.trim() !== '' || nextMethod.trim() !== '';
    if (has && (slot.current === null || slot.current === ADD_SLOT)) { slot.open(ADD_SLOT); slot.setDirty(true); }
    if (!has && slot.current === ADD_SLOT) slot.close();
  };
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
    // 성공한 요청 내용과 지금 입력이 같을 때만 비운다(응답을 기다리는 동안 입력한 다음 항목 지키기).
    onSuccess: (_r, x) => {
      if (x.content === text.trim() && x.method === method.trim()) { setText(''); setMethod(''); if (slot.current === ADD_SLOT) slot.close(); }
    },
    successNotice: '체크리스트 항목을 추가했습니다.',
  });
  return (
    <div className="pane">
      <div className="pane-h"><div className="pane-hl"><h3>체크리스트</h3><span className="muted">{tot ? `${String(done)}/${String(tot)}` : '0/0'} 완료</span></div></div>
      {(!tot || reqLeft > 0) && <div className="banner warn" style={{ margin: '0 0 14px' }}><div className="banner-b"><b>Completion Gate 미통과</b> — {!tot ? '체크리스트가 등록되지 않았습니다.' : `필수 항목 ${String(reqLeft)}건이 미완료라 완료 처리할 수 없습니다.`}</div></div>}
      {tot > 0 && !reqLeft && <div className="banner ok" style={{ margin: '0 0 14px' }}><div className="banner-b"><b>필수 항목 모두 완료</b> — Completion Gate의 체크리스트 조건을 충족했습니다.</div></div>}
      <div className="gtb" role="table" aria-label="체크리스트">
        <div className="gtr h" style={{ gridTemplateColumns: GRID }} role="row"><span role="columnheader" className="gc">완료</span><span role="columnheader" className="gc">항목 ID</span><span role="columnheader" className="gc">체크 내용</span><span role="columnheader" className="gc">구분</span><span role="columnheader" className="gc">검증 방법</span><span role="columnheader" className="gc">관련 Evidence</span><span role="columnheader" className="gc">결과·비고</span></div>
        {items.map((ci) => (
          <div className={`gtr ${ci.done ? 'dim' : ''}`} key={ci.itemKey} style={{ gridTemplateColumns: GRID }} role="row">
            <span role="cell" className="gc">
              {busyKey === ci.itemKey ? <span className="bspin" aria-label="저장 중" /> : (
                <input type="checkbox" className="chk" checked={ci.done} disabled={toggle.busy} aria-label={`${ci.itemKey} ${ci.content}${ci.done ? ' 완료됨' : ' 미완료'}`}
                  onChange={() => { toggling.current = { key: ci.itemKey, done: !ci.done }; setBusyKey(ci.itemKey); setMine(`${ci.itemKey} ${ci.done ? '미완료' : '완료'}`); void toggle.save().then((ok) => { if (!ok) setBusyKey(null); }); }} />
              )}
            </span>
            <span role="cell" className="gc mono">{ci.itemKey}</span>
            <span role="cell" className="gc">{ci.content}</span>
            <span role="cell" className="gc"><span className={ci.required ? 'req' : 'opt'}>{ci.required ? '필수' : '선택'}</span></span>
            <span role="cell" className="gc">{ci.verifyMethod || '—'}</span>
            <span role="cell" className="gc mono">{ci.evidence || '—'}</span>
            <span role="cell" className="gc muted">{ci.note ?? ''}</span>
          </div>
        ))}
        {!tot && <div className="gtr" role="row"><span role="cell" className="gc muted">등록된 체크리스트가 없습니다. 아래에서 항목을 추가하세요.</span></div>}
      </div>
      <div className="addbox">
        <h4>항목 추가</h4>
        <div className="addbox-r">
          <label className="sr" htmlFor="cl-text">체크 내용</label>
          <input id="cl-text" className="inp" style={{ flex: 2, minWidth: 240 }} placeholder="체크 내용 (필수)" value={text} onChange={(e) => { setText(e.target.value); track(e.target.value, method); }} />
          <label className="sr" htmlFor="cl-m">검증 방법</label>
          <input id="cl-m" className="inp" style={{ flex: 1, minWidth: 180 }} placeholder="검증 방법 (선택)" value={method} onChange={(e) => { setMethod(e.target.value); track(text, e.target.value); }} />
          <div className="seg" role="group" aria-label="필수 여부">{([[true, '필수'], [false, '선택']] as const).map(([v, l]) => <button type="button" key={l} aria-pressed={req === v} onClick={() => { setReq(v); }}>{l}</button>)}</div>
          <BusyButton small busy={add.busy} busyLabel="추가 중…" disabled={!text.trim()} onClick={() => { void add.save(); }}>추가</BusyButton>
        </div>
      </div>
      {toggle.conflictModal}
      {add.conflictModal}
    </div>
  );
}
