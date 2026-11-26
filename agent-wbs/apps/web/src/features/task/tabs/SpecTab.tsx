/**
 * 작업 명세 탭(UI-03-02) — 6그룹 13섹션, 원본 P L1131–1157.
 * - 줄 목록 섹션은 그 자리에서 textarea로 편집한다(P L5353 saveSpec).
 * - AC·산출물은 구조화 편집기(UI-03F)로 편집한다. Given/When/Then·검증 방법, 경로/유형/필수/검증 조건/제출을 칸별로 보존한다.
 * - 명세 저장 API(PATCH …/spec)는 spec 묶음 전체를 받으므로, 바꾼 섹션 외에는 지금 값을 그대로 보낸다.
 */
import { useEffect, useState } from 'react';
import { BusyButton } from '../../../shared/ui/BusyButton.tsx';
import { useEditSlot } from '../edit-slot.tsx';
import { draftBlocks, fromDraft, toDraft, validateDraft, type EditorDraft, type Row } from '../editor-model.ts';
import { COLSETS, SPEC_GROUPS, SPEC_TBL, toLines, type SpecKey, type TaskDetailData } from '../labels.ts';
import { Lines, ReadTable } from '../parts.tsx';
import { StructuredEditor } from '../StructuredEditor.tsx';
import { specFilled } from '../TaskDetail.tsx';
import { useApiClient, useTaskSave } from '../useTaskData.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const EMPTY_TEXT: Partial<Record<string, string>> = {
  __out: '제외 범위가 정의되지 않았습니다 — 구현 범위가 모호해질 수 있습니다.',
  __outputs: '산출물이 정의되지 않았습니다 — Completion Gate의 산출물 조건을 통과할 수 없습니다.',
  ac: 'Acceptance Criteria가 없습니다 — 완료 판단 기준이 모호합니다.',
};

export function SpecTab({ task: t }: { task: TaskDetailData }) {
  const slot = useEditSlot();
  const { filled, total } = specFilled(t);
  const tbl = slot.current?.startsWith('spec-tbl:') ? (slot.current.slice(9) as 'ac' | 'outputs') : null;
  if (tbl) return <SpecTableEditor task={t} which={tbl} />;
  return (
    <div className="pane">
      <div className="pane-h"><div className="pane-hl"><h3>작업 명세</h3><span className="muted">작성 {filled} / {total} 섹션</span></div></div>
      <div className="banner info" style={{ margin: '0 0 14px' }}>
        <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" /></svg>
        <div className="banner-b">공식 Task 명세입니다. 메시지로 전달한 추가 지시는 이 명세를 자동으로 바꾸지 않습니다. 승인된 Task의 범위·AC·선행 관계 변경은 [변경 제안]의 승인과 「WBS 반영」을 거쳐 이 명세에 적용됩니다.</div>
      </div>
      {SPEC_GROUPS.map((g) => (
        <div className="sgrp" key={g.label} role="group" aria-label={g.label}>
          <div className="sgrp-h"><span className={`sgrp-k ${g.cls}`}>{g.label}</span><span className="muted">{g.desc}</span></div>
          {g.keys.map((sec) => {
            const isT = sec.mode?.startsWith('tbl:') ?? false;
            const rows: unknown[] = sec.key === '__out' ? t.spec.overview.out : sec.key === '__outputs' ? t.outputs : sec.key === 'ac' ? t.spec.ac : t.spec.spec[sec.key];
            const editing = slot.current === `spec:${sec.key}`;
            return (
              <div className="ssec" key={sec.key} role="region" aria-label={sec.title}>
                <div className="ssec-h"><h4>{sec.title}</h4>{!editing && slot.current === null && <button type="button" className="btn ghost sm" aria-label={`${sec.title} 편집`} onClick={() => { slot.open(isT ? `spec-tbl:${sec.key === 'ac' ? 'ac' : 'outputs'}` : `spec:${sec.key}`); }}>편집</button>}</div>
                {editing ? <SpecLinesEditor task={t} sec={sec.key as SpecKey | '__out'} title={sec.title} /> : !rows.length ? <p className="empty" style={{ margin: 0 }}>{EMPTY_TEXT[sec.key] ?? '미작성 — 편집을 눌러 작성하세요.'}</p> : isT ? (
                  sec.key === 'ac'
                    ? <ReadTable label="Acceptance Criteria" cols={[{ k: '_id', l: 'ID', w: '64px', mono: true, b: true }, ...(COLSETS.ac ?? [])]} rows={t.spec.ac.map((x, i) => ({ _id: `AC-${String(i + 1)}`, ...x }))} />
                    : <ReadTable label="산출물 및 검증 조건" cols={COLSETS.outputs ?? []} rows={t.outputs} />
                ) : <Lines items={rows as string[]} mono={sec.mode === 'mono'} ordered={sec.mode === 'ol'} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** 줄 목록 섹션 편집(P L1147–1151) */
function SpecLinesEditor({ task: t, sec, title }: { task: TaskDetailData; sec: SpecKey | '__out'; title: string }) {
  const slot = useEditSlot();
  const client = useApiClient();
  const initial = (sec === '__out' ? t.spec.overview.out : t.spec.spec[sec]).join('\n');
  const [text, setText] = useState(() => (typeof slot.restored === 'string' ? slot.restored : initial));
  useEffect(() => { slot.report(text); }, [text, slot]);
  useEffect(() => { slot.setDirty(text !== initial); }, [text, initial, slot]);
  const save = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 작업 명세 「${title}」 저장`,
    mine: `${title}: ${String(toLines(text).length)}항목`,
    request: () => ({ lines: toLines(text), overview: t.spec.overview, spec: t.spec.spec }),
    run: ({ updatedAt, payload: p }) => client.call('updateTaskSpec', {
      params: { taskKey: t.taskKey },
      body: sec === '__out' ? { updatedAt, overview: { ...p.overview, out: p.lines } } : { updatedAt, spec: { ...p.spec, [sec]: p.lines } },
    }),
    onSuccess: (_r, p) => { if (same(p.lines, toLines(text))) slot.close(); },
    onReload: () => { slot.close(); },
    successNotice: `「${title}」을(를) 저장했습니다.`,
  });
  return (
    <>
      <label className="sr" htmlFor="spec-ed">{title} 편집</label>
      <textarea id="spec-ed" rows={7} className="inp mono-in" value={text} onChange={(e) => { setText(e.target.value); }} />
      <div className="edit-acts">
        <span className="fhint">한 줄에 한 항목 · `백틱`으로 코드·경로 표시</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn sm" disabled={save.busy} onClick={() => { slot.close(); }}>취소</button>
          <BusyButton small busy={save.busy} busyLabel="저장 중…" onClick={() => { void save.save(); }}>저장</BusyButton>
        </span>
      </div>
      {save.conflictModal}
    </>
  );
}

/** AC·산출물 표 편집(UI-03F, P L5530 openSpecTbl) */
function SpecTableEditor({ task: t, which }: { task: TaskDetailData; which: 'ac' | 'outputs' }) {
  const slot = useEditSlot();
  const client = useApiClient();
  const block = SPEC_TBL[which];
  const source = (which === 'ac' ? t.spec.ac : t.outputs) as unknown as Row[];
  const [draft, setDraft] = useState<EditorDraft>(() => (slot.restored as EditorDraft | null) ?? { kind: 'spec', sec: '', idx: -1, key: which, f: {}, b: toDraft([block], { [which]: source }) });
  const [touched, setTouched] = useState(slot.restored !== null);
  useEffect(() => { slot.report(draft); }, [draft, slot]);
  useEffect(() => { slot.setDirty(touched); }, [touched, slot]);
  const check = validateDraft(draft, { known: {}, ownApi: [] });
  const value = () => fromDraft(draftBlocks(draft), draft.b)[which] as Row[];
  const save = useTaskSave(t.taskKey, {
    target: `${t.taskKey} ${block.l} 저장`,
    mine: `${block.l}: ${String(value().length)}항목`,
    request: () => value(),
    run: ({ updatedAt, payload: rows }) => (which === 'ac'
      ? client.call('updateTaskSpec', { params: { taskKey: t.taskKey }, body: { updatedAt, ac: rows.map((r) => ({ given: String(r.given ?? ''), when: String(r.when ?? ''), then: String(r.then ?? ''), method: String(r.method ?? '') })) } })
      : client.call('updateTaskOutputs', { params: { taskKey: t.taskKey }, body: { updatedAt, outputs: rows.map((r) => ({ name: String(r.name ?? ''), kind: String(r.kind ?? ''), required: r.required === true, verify: String(r.verify ?? ''), delivered: r.delivered === true })) } })),
    onSuccess: (_r, p) => { if (same(p, value())) slot.close(); },
    onReload: () => { slot.close(); },
    successNotice: `「${block.l}」을(를) 저장했습니다.${which === 'outputs' ? ' Completion Gate가 다시 계산되었습니다.' : ''}`,
  });
  return (
    <>
      <StructuredEditor
        title={`${block.l} 편집`} sub={`${t.taskKey} · 작업 명세 「완료 판단」`} draft={draft} check={check} busy={save.busy}
        onChange={(d) => { setTouched(true); setDraft(d); }} onCancel={() => { slot.close(); }} onSave={() => { void save.save(); }}
      />
      {save.conflictModal}
    </>
  );
}
