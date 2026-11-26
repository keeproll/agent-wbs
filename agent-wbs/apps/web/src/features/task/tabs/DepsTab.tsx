/**
 * 의존성 탭(UI-03-03) — 원본 P L1159–1210.
 * - 후보를 고르면 바로 서버에 저장을 요청한다. 자기 참조·중복·순환은 서버가 409로 거부하고, 이 화면은 「저장 차단」과 순환 경로를 보인다.
 *   왜 화면에서 미리 막지 않나: 모든 Task의 관계를 가진 서버가 판정해야 정확하다(원본도 선택 즉시 검사 후 저장).
 * - 삭제는 확인창을 거친다(MOD-08).
 */
import { useRef, useState } from 'react';
import { ApiError } from '../../../shared/api/client.ts';
import { useConfirm } from '../../../shared/ui/feedback.tsx';
import { useEditSlot } from '../edit-slot.tsx';
import { DEP_LABEL, statusOf, type TaskDetailData, type TaskSummaryData } from '../labels.ts';
import { depMet } from '../TaskDetail.tsx';
import { useApiClient, useTaskSave } from '../useTaskData.ts';

const DEP_GRID = '110px minmax(160px,1fr) 150px 120px 90px 70px';
const SUCC_GRID = '110px minmax(160px,1fr) 150px 120px 150px';
/** 원본 depTypes 설명(P L1168) */
const DEP_TYPES = [{ k: 'FS', l: '완료 → 시작 (FS)', tip: '선행 Task가 완료되어야 시작' }, { k: 'SS', l: '시작 → 시작 (SS)', tip: '선행 Task가 시작되어야 시작' }] as const;

export function DepsTab({ task: t, tasks, byKey, blocked, onOpenTask }: {
  task: TaskDetailData; tasks: TaskSummaryData[]; byKey: Map<string, TaskSummaryData>; blocked: boolean; onOpenTask: (k: string, ref: boolean) => void;
}) {
  const slot = useEditSlot();
  const client = useApiClient();
  const confirm = useConfirm();
  const open = slot.current === 'deps-add';
  const [q, setQ] = useState('');
  const [type, setType] = useState<'FS' | 'SS'>('FS');
  const [pick, setPick] = useState('');
  // 클릭한 그 순간의 값으로 저장 요청을 보내려고 ref에도 둔다(상태는 다음 렌더에야 바뀐다).
  const pickRef = useRef('');
  const removingRef = useRef<{ id: string; pred: string } | null>(null);
  const [blockErr, setBlockErr] = useState<{ t: string; path: string } | null>(null);
  const linked = new Set(t.predecessors.map((p) => p.pred));
  const ql = q.trim().toLowerCase();
  const cands = tasks
    .filter((x) => !linked.has(x.taskKey))
    .filter((x) => !ql || x.taskKey.toLowerCase().includes(ql) || x.title.toLowerCase().includes(ql))
    .sort((a, b) => a.wbsPath.localeCompare(b.wbsPath, undefined, { numeric: true }))
    .slice(0, 8);
  const add = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 선행 Task 추가`,
    failTitle: '선행 관계를 저장하지 못했습니다',
    mine: `선행 ${pick} (${type})`,
    run: ({ idempotencyKey, updatedAt }) => client.call('addDependency', { params: { taskKey: t.taskKey }, body: { updatedAt, predTaskKey: pickRef.current, depType: type }, idempotencyKey }),
    onSuccess: () => { setBlockErr(null); setQ(''); slot.close(); },
    onRejected: (error: ApiError) => {
      const path = (error.body?.error.details as { path?: string[] } | undefined)?.path;
      setBlockErr({ t: error.body?.error.message ?? error.code, path: path?.length ? path.join(' → ') : '' });
    },
    notice: () => `선행 관계 ${pickRef.current} → ${t.taskKey}를 추가했습니다.`,
  });
  const remove = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 선행 관계 삭제`,
    run: ({ updatedAt }) => client.call('deleteDependency', { params: { dependencyId: removingRef.current?.id ?? '' }, query: { updatedAt } }),
    notice: () => `선행 관계 ${removingRef.current?.pred ?? ''} → ${t.taskKey}를 삭제했습니다.`,
  });
  const isDone = String(t.lifecycleStatus) === 'done';
  return (
    <div className="pane">
      <div className="pane-h"><h3>의존성</h3><button type="button" className="btn sm" disabled={!open && slot.current !== null} onClick={() => { if (open) { slot.close(); setBlockErr(null); } else slot.open('deps-add'); }}>{open ? '추가 닫기' : '+ 선행 Task 추가'}</button></div>
      {blocked && <div className="banner danger" style={{ margin: '0 0 14px' }}><div className="banner-b"><b>실행 불가</b> — 선행 Task {t.predecessors.filter((p) => !depMet(p.type, byKey.get(p.pred))).length || t.predecessors.length}건이 조건을 충족하지 않았습니다. 충족되면 자동으로 실행 가능 상태로 바뀝니다.</div></div>}
      {!blocked && !isDone && <div className="banner ok" style={{ margin: '0 0 14px' }}><div className="banner-b"><b>실행 가능</b> — 모든 선행 조건이 충족되었습니다.</div></div>}
      {open && (
        <div className="addbox">
          <div className="addbox-r">
            <span className="flabel" style={{ padding: 0 }}>의존성 유형</span>
            <div className="seg" role="group" aria-label="의존성 유형">{DEP_TYPES.map((o) => <button type="button" key={o.k} aria-pressed={type === o.k} title={o.tip} onClick={() => { setType(o.k); }}>{o.l}</button>)}</div>
            <label className="search" style={{ flex: 1, minWidth: 240 }}>
              <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" /></svg>
              <span className="sr">선행 Task 검색</span>
              <input type="search" placeholder="선행으로 추가할 Task ID 또는 제목" value={q} onChange={(e) => { setQ(e.target.value); }} />
            </label>
          </div>
          {blockErr && <div className="banner danger" style={{ margin: '0 0 8px' }} role="alert"><div className="banner-b"><b>저장 차단</b> — {blockErr.t}{blockErr.path && <><br /><span className="mono">{blockErr.path}</span></>}</div></div>}
          <div className="cand" role="list" aria-label="선행 후보">
            {cands.map((cd) => {
              const s = statusOf(String(cd.lifecycleStatus));
              return (
                <button type="button" key={cd.taskKey} role="listitem" disabled={add.busy} onClick={() => { pickRef.current = cd.taskKey; setPick(cd.taskKey); setBlockErr(null); void add.save(); }}>
                  <span className="mono muted">{cd.wbsPath}</span><span className="mono">{cd.taskKey}</span>
                  <span>{cd.title}{cd.taskKey === t.taskKey && <span className="muted"> (현재 Task)</span>}</span>
                  <span className={`st ${s.c}`}><span className="st-d" aria-hidden="true" />{s.l}</span>
                </button>
              );
            })}
          </div>
          <p className="fhint" style={{ margin: '8px 0 0' }}>선택 즉시 자기 참조·중복·순환 여부를 검사하고, 문제가 없을 때만 저장합니다.</p>
        </div>
      )}
      <h4>선행 Task ({t.predecessors.length})</h4>
      <div className="gtb" role="table" aria-label="선행 Task">
        <div className="gtr h" style={{ gridTemplateColumns: DEP_GRID }} role="row"><span className="gc">Task ID</span><span className="gc">제목</span><span className="gc">의존성 유형</span><span className="gc">선행 상태</span><span className="gc">충족</span><span className="gc" /></div>
        {t.predecessors.map((p) => {
          const pt = byKey.get(p.pred);
          const s = statusOf(String(pt?.lifecycleStatus ?? ''));
          const met = depMet(p.type, pt);
          return (
            <div className="gtr" key={p.id} style={{ gridTemplateColumns: DEP_GRID }} role="row">
              <span className="gc"><button type="button" className="reflink" onClick={() => { onOpenTask(p.pred, true); }}>{p.pred}</button></span>
              <span className="gc">{pt?.title ?? ''}</span>
              <span className="gc">{DEP_LABEL[String(p.type)]}</span>
              <span className="gc">{pt && <span className={`st ${s.c}`}><span className="st-d" aria-hidden="true" />{s.l}</span>}</span>
              <span className="gc"><span className={met ? 'okt' : 'blk'}>{met ? '충족' : '미충족 — 차단'}</span></span>
              <span className="gc"><button type="button" className="btn ghost sm" aria-label={`${p.pred} 선행 관계 삭제`} disabled={remove.busy} onClick={() => {
                removingRef.current = { id: p.id, pred: p.pred };
                void confirm({ title: '선행 관계 삭제', body: `${p.pred} → ${t.taskKey} 선행 관계를 삭제합니다. 실행 차단 여부가 다시 계산되며 이력에 기록됩니다.`, ok: '삭제', danger: true })
                  .then((ok) => { if (ok) void remove.save(); });
              }}>삭제</button></span>
            </div>
          );
        })}
        {!t.predecessors.length && <div className="gtr"><span className="gc muted">선행 Task가 없습니다.</span></div>}
      </div>
      <h4>후속 Task ({t.successors.length})</h4>
      <div className="gtb" role="table" aria-label="후속 Task">
        <div className="gtr h" style={{ gridTemplateColumns: SUCC_GRID }} role="row"><span className="gc">Task ID</span><span className="gc">제목</span><span className="gc">의존성 유형</span><span className="gc">후속 상태</span><span className="gc">이 Task로 인한 차단</span></div>
        {t.successors.map((p) => {
          const st = byKey.get(p.succ);
          const s = statusOf(String(st?.lifecycleStatus ?? ''));
          const met = depMet(p.type, byKey.get(t.taskKey) ?? ({ lifecycleStatus: t.lifecycleStatus } as TaskSummaryData));
          return (
            <div className="gtr" key={p.id} style={{ gridTemplateColumns: SUCC_GRID }} role="row">
              <span className="gc"><button type="button" className="reflink" onClick={() => { onOpenTask(p.succ, true); }}>{p.succ}</button></span>
              <span className="gc">{st?.title ?? ''}</span>
              <span className="gc">{DEP_LABEL[String(p.type)]}</span>
              <span className="gc">{st && <span className={`st ${s.c}`}><span className="st-d" aria-hidden="true" />{s.l}</span>}</span>
              <span className="gc"><span className={met ? 'okt' : 'blk'}>{met ? '차단하지 않음' : '후속 Task 차단 중'}</span></span>
            </div>
          );
        })}
        {!t.successors.length && <div className="gtr"><span className="gc muted">이 Task를 선행으로 둔 후속 Task가 없습니다.</span></div>}
      </div>
      {add.conflictModal}
      {remove.conflictModal}
    </div>
  );
}
