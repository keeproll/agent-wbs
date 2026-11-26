/**
 * 기술 설계 탭(UI-03-04) — 원본 P L1213–1267, 편집 P L5453–5636.
 * - 기술 영역에 맞는 섹션만 권장하고, 모든 Task에 모든 섹션을 강제하지 않는다.
 * - DB 테이블·API Endpoint는 엔티티 단위, 나머지는 블록 단위로 구조화 편집기(UI-03F)에서 편집한다.
 * - 검사(중복 테이블·없는 FK·nullable PK·없는 인덱스 컬럼·중복 Endpoint·HTTP·환경 변수)는 저장 전에 화면이 한다.
 *   서버는 설계 내용을 검사하지 않는다(보고함). 그래서 다른 Task의 테이블을 알기 위해 DB 편집기를 열 때 관련 Task 상세를 읽는다.
 * - 섹션 제거는 빈 내용 `{}` 저장으로 한다(설계 섹션 삭제 API가 없음, 보고함).
 */
import { useQueries } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { apiKey } from '../../../shared/api/queries.ts';
import { useConfirm } from '../../../shared/ui/feedback.tsx';
import { useEditSlot } from '../edit-slot.tsx';
import {
  blankEntity, draftBlocks, fromDraft, isDesignPresent, knownTables, relationRows, toDraft, validateDraft,
  type BlockValue, type DesignContent, type DesignEnt, type EditorDraft, type Known,
} from '../editor-model.ts';
import { COLSETS, DESIGN, DESIGN_KINDS, DOMAIN_TO_DESIGN, type Block, type DesignKind, type TaskDetailData, type TaskSummaryData } from '../labels.ts';
import { Lines, ReadTable } from '../parts.tsx';
import { StructuredEditor } from '../StructuredEditor.tsx';
import { useApiClient, useTaskSave } from '../useTaskData.ts';

/** 내용이 있는 설계 섹션(빈 `{}`는 제거된 섹션) */
export const presentDesigns = (t: TaskDetailData) =>
  t.designs.filter((d) => isDesignPresent(d.content)).map((d) => ({ kind: String(d.kind) as DesignKind, content: d.content as DesignContent }));

const recKinds = (t: TaskDetailData): DesignKind[] => {
  const out: DesignKind[] = [];
  for (const x of [String(t.primaryDomain), ...t.relatedDomains.map(String)]) {
    const k = DOMAIN_TO_DESIGN[x];
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
};

const filled = (v: BlockValue | undefined, t: Block['t']) => (t === 'code' ? typeof v === 'string' && v.trim() !== '' : Array.isArray(v) && v.length > 0);

/** 다른 Task가 정의한 DB 테이블(FK 검사·관계 테이블용). enabled일 때만 DB 관련 Task 상세를 읽는다. */
function useKnown(t: TaskDetailData, tasks: TaskSummaryData[], enabled: boolean, skip: { task: string; idx: number } | null): Known {
  const client = useApiClient();
  const others = tasks.filter((x) => x.taskKey !== t.taskKey && [String(x.primaryDomain), ...x.relatedDomains.map(String)].some((d) => d === 'DB' || d === 'BE' || d === 'API'));
  const results = useQueries({
    queries: others.map((x) => ({
      queryKey: apiKey('getTask', { params: { taskKey: x.taskKey } }),
      queryFn: ({ signal }: { signal: AbortSignal }) => client.call('getTask', { params: { taskKey: x.taskKey }, signal }),
      enabled, meta: { topics: ['task'] }, staleTime: 30_000,
    })),
  });
  const details = [t, ...results.map((r) => r.data).filter((x) => x !== undefined)];
  return knownTables(details.map((d) => ({ taskKey: d.taskKey, designs: d.designs.map((s) => ({ kind: String(s.kind), content: s.content })) })), skip);
}

export function DesignTab({ task: t, tasks }: { task: TaskDetailData; tasks: TaskSummaryData[] }) {
  const slot = useEditSlot();
  const client = useApiClient();
  const confirm = useConfirm();
  const secs = presentDesigns(t);
  const [ed, setEd] = useState<{ draft: EditorDraft; title: string } | null>(null);
  const editing = slot.current === 'design' && ed !== null;
  const hasDb = secs.some((s) => s.kind === 'DB');
  const known = useKnown(t, tasks, hasDb || (editing && ed.draft.sec === 'DB'), editing && ed.draft.kind === 'ent' ? { task: t.taskKey, idx: ed.draft.idx } : null);
  const have = secs.map((s) => s.kind);
  const rec = recKinds(t);
  const [pending, setPending] = useState<{ kind: DesignKind; content: DesignContent; notice: string; mine: string } | null>(null);
  const write = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 기술 설계 저장`,
    mine: pending?.mine ?? '',
    request: () => pendingRef.current ?? { kind: 'DB' as DesignKind, content: {}, notice: '', mine: '' },
    run: ({ updatedAt, payload: p }) => client.call('updateTaskDesign', { params: { taskKey: t.taskKey, kind: p.kind }, body: { updatedAt, content: p.content as Record<string, unknown> } }),
    onSuccess: () => { setEd(null); slot.close(); },
    onReload: () => { setEd(null); slot.close(); },
    notice: (p) => p.notice,
  });
  // 저장 요청은 누른 순간의 값을 보내야 해서 ref에도 둔다(상태는 다음 렌더에야 바뀐다).
  const pendingRef = useRef<typeof pending>(null);
  const commit = (kind: DesignKind, content: DesignContent, notice: string, mine: string) => {
    pendingRef.current = { kind, content, notice, mine };
    setPending(pendingRef.current);
    void write.save();
  };
  const contentOf = (kind: DesignKind): DesignContent => secs.find((s) => s.kind === kind)?.content ?? { ents: [], b: {} };

  if (editing) {
    const d = ed.draft;
    const own = d.sec === 'API' ? (contentOf('API').ents ?? []).filter((_, i) => i !== d.idx).map((e) => ({ method: e.f.method ?? '', path: e.f.path ?? '' })) : [];
    const check = validateDraft(d, { known, ownApi: own });
    return (
      <>
        <StructuredEditor
          title={ed.title} sub={`${t.taskKey} · ${d.sec ? DESIGN[d.sec].label : ''}`} draft={d} check={check} busy={write.busy}
          onChange={(next) => { slot.setDirty(true); setEd({ ...ed, draft: next }); }}
          onCancel={() => { setEd(null); slot.close(); }}
          onSave={() => {
            if (!d.sec) return;
            const kind = d.sec;
            const cur = contentOf(kind);
            const val = fromDraft(draftBlocks(d), d.b);
            if (d.kind === 'ent') {
              const sc = DESIGN[kind].ent;
              const f = Object.fromEntries(Object.entries(d.f).map(([k, v]) => [k, v.trim()]));
              const ent: DesignEnt = { f, b: val };
              const nm = kind === 'DB' ? f.name ?? '' : `${f.method ?? ''} ${f.path ?? ''}`;
              const ents = [...(cur.ents ?? [])];
              if (d.idx < 0) ents.push(ent); else ents[d.idx] = ent;
              commit(kind, { ...cur, ents }, `${sc?.label ?? ''} ${nm}을(를) 저장했습니다.`, `${DESIGN[kind].label} · ${sc?.label ?? ''} ${nm}`);
            } else {
              const bk = draftBlocks(d)[0];
              commit(kind, { ...cur, b: { ...(cur.b ?? {}), ...val } }, `「${bk?.l ?? ''}」을(를) 저장했습니다.`, `${DESIGN[kind].label} · ${bk?.l ?? ''}`);
            }
          }}
        />
        {write.conflictModal}
      </>
    );
  }

  const openEnt = (kind: DesignKind, idx: number) => {
    const sc = DESIGN[kind].ent;
    if (!sc) return;
    const en = idx < 0 ? blankEntity(kind) : (contentOf(kind).ents ?? [])[idx] ?? blankEntity(kind);
    const nm = kind === 'DB' ? en.f.name ?? '' : `${en.f.method ?? ''} ${en.f.path ?? ''}`;
    slot.open('design');
    setEd({ title: idx < 0 ? `${sc.label} 추가` : `${sc.label} 편집 — ${nm}`, draft: { kind: 'ent', sec: kind, idx, key: '', f: { ...en.f }, b: toDraft(sc.blocks, en.b) } });
  };
  const openBlk = (kind: DesignKind, bk: Block) => {
    slot.open('design');
    setEd({ title: `${bk.l} 편집`, draft: { kind: 'blk', sec: kind, idx: -1, key: bk.k, f: {}, b: toDraft([bk], contentOf(kind).b) } });
  };
  const busyOrEditing = slot.current !== null || write.busy;

  return (
    <div className="pane">
      <div className="pane-h"><div className="pane-hl"><h3>기술 설계</h3><span className="muted">기술 영역에 필요한 섹션만 작성 · 읽기 모드 기본, 항목별 편집</span></div></div>
      <p className="fhint" style={{ margin: '0 0 10px' }}>
        {rec.length
          ? `기술 영역 ${[String(t.primaryDomain), ...t.relatedDomains.map(String)].join(' · ')} 기준 권장 섹션: ${rec.map((k) => DESIGN[k].label).join(', ')} — 필요한 섹션만 작성합니다.`
          : `기술 영역(${String(t.primaryDomain)})에는 기본 설계 섹션이 없습니다. 필요한 경우에만 추가하세요.`}
      </p>
      {DESIGN_KINDS.some((k) => !have.includes(k)) && (
        <div className="secadd"><span className="muted">섹션 추가</span>
          {DESIGN_KINDS.filter((k) => !have.includes(k)).map((k) => (
            <button type="button" key={k} className={rec.includes(k) ? 'btn sm rec' : 'btn ghost sm'} title={rec.includes(k) ? '기술 영역 기준 권장 섹션' : '필요한 경우에만 추가'} disabled={busyOrEditing}
              onClick={() => { commit(k, { ents: [], b: {} }, `${DESIGN[k].label} 섹션을 추가했습니다.`, `${DESIGN[k].label} 섹션 추가`); }}>+ {DESIGN[k].label}</button>
          ))}
        </div>
      )}
      {!secs.length && <p className="empty">이 Task에는 아직 기술 설계 섹션이 없습니다.</p>}
      {secs.map(({ kind, content }) => {
        const sc = DESIGN[kind];
        const ents = content.ents ?? [];
        const rel = kind === 'DB' ? relationRows(t.taskKey, content, known) : [];
        const n = ents.length + Object.entries(content.b ?? {}).filter(([, v]) => (Array.isArray(v) ? v.length : String(v).trim())).length;
        return (
          <section className="dsec" key={kind} aria-label={sc.label}>
            <div className="dsec-h">
              <div className="pane-hl"><span className="dm">{kind}</span><h3>{sc.label}</h3><span className="muted">{sc.desc}</span></div>
              <span style={{ display: 'flex', gap: 6 }}>
                {sc.ent && <button type="button" className="btn sm" disabled={busyOrEditing} onClick={() => { openEnt(kind, -1); }}>+ {sc.ent.addL}</button>}
                <button type="button" className="btn ghost sm" disabled={busyOrEditing} onClick={() => {
                  void confirm({ title: '설계 섹션 제거', body: `${sc.label} 섹션을 제거합니다.${n ? ` 작성된 내용 ${String(n)}건이 함께 삭제됩니다.` : ''} 이력에 기록됩니다.`, ok: '섹션 제거', danger: true })
                    .then((ok) => { if (ok) commit(kind, {}, `${sc.label} 섹션을 제거했습니다.`, `${sc.label} 섹션 제거`); });
                }}>섹션 제거</button>
              </span>
            </div>
            <div className="dsec-b">
              {sc.ent && !ents.length && <p className="empty" style={{ margin: '0 0 8px' }}>{sc.ent.label}가 없습니다. 「{sc.ent.addL}」로 정의하세요.</p>}
              {ents.map((en, i) => {
                const nm = kind === 'DB' ? en.f.name ?? '' : en.f.path ?? '';
                return (
                  <div className="dent" key={i} role="group" aria-label={kind === 'DB' ? `테이블 ${nm}` : `${en.f.method ?? ''} ${nm}`}>
                    <div className="dent-h">
                      {kind === 'API' && <span className={`mth m-${(en.f.method ?? '').toLowerCase()}`}>{en.f.method}</span>}
                      <span className="dent-n mono">{nm}</span>
                      {kind === 'DB' && <span className={`tag ${en.f.change === '신규' ? 'new' : en.f.change === '삭제' ? 'del' : 'chg'}`}>{en.f.change}</span>}
                      <span className="muted">{en.f.desc}</span>
                      <span className="sp" />
                      {kind === 'API' && <span className="muted">인증: {en.f.auth || '—'}</span>}
                      <button type="button" className="btn ghost sm" disabled={busyOrEditing} onClick={() => { openEnt(kind, i); }}>편집</button>
                      <button type="button" className="btn ghost sm" disabled={busyOrEditing} onClick={() => {
                        void confirm({ title: `${sc.ent?.label ?? ''} 삭제`, body: `${kind === 'DB' ? nm : `${en.f.method ?? ''} ${nm}`}을(를) 기술 설계에서 삭제합니다. 이력에 기록됩니다.`, ok: '삭제', danger: true })
                          .then((ok) => { if (ok) commit(kind, { ...content, ents: ents.filter((_, j) => j !== i) }, `${sc.ent?.label ?? ''} ${nm}을(를) 삭제했습니다.`, `${sc.ent?.label ?? ''} ${nm} 삭제`); });
                      }}>삭제</button>
                    </div>
                    {sc.ent?.blocks.map((bk) => <ReadBlock key={bk.k} bk={bk} value={en.b[bk.k]} />)}
                  </div>
                );
              })}
              {rel.length > 0 && (
                <div className="rblk"><div className="tsec-h"><h4>관계 테이블</h4><span className="fhint">컬럼 정의의 FK에서 자동 계산</span></div>
                  <ReadTable label="관계 테이블" cols={[{ k: 'from', l: 'FK 컬럼', w: '240px', mono: true, b: true }, { k: 'to', l: '참조 대상', w: '200px', mono: true }, { k: 'card', l: '관계', w: '90px', mono: true }, { k: 'ok', l: '참조 테이블 위치', w: '1fr' }]} rows={rel} />
                </div>
              )}
              {sc.blocks.map((bk) => <ReadBlock key={bk.k} bk={bk} value={content.b?.[bk.k]} onEdit={busyOrEditing ? undefined : () => { openBlk(kind, bk); }} />)}
            </div>
          </section>
        );
      })}
      {write.conflictModal}
    </div>
  );
}

function ReadBlock({ bk, value, onEdit }: { bk: Block; value: BlockValue | undefined; onEdit?: (() => void) | undefined }) {
  const has = filled(value, bk.t);
  return (
    <div className="rblk" role="region" aria-label={bk.l}>
      <div className="tsec-h"><h4>{bk.l}</h4><span className="sp" />{onEdit && <button type="button" className="btn ghost sm" aria-label={`${bk.l} 편집`} onClick={onEdit}>편집</button>}</div>
      {!has && <p className="empty" style={{ margin: 0 }}>미작성</p>}
      {has && bk.t === 'table' && <ReadTable label={bk.l} cols={COLSETS[bk.cols ?? ''] ?? []} rows={value as Record<string, unknown>[]} />}
      {has && bk.t === 'lines' && <Lines items={value as string[]} />}
      {has && bk.t === 'code' && <pre className="code"><code>{value as string}</code></pre>}
    </div>
  );
}
