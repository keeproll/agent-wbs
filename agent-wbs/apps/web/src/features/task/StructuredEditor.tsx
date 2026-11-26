/**
 * 구조화 명세·기술 설계 공용 편집기(UI-03F) — 원본 P L978–1026 마크업 그대로.
 * AC·산출물 표, DB 테이블·API Endpoint, 설계 블록(표·줄 목록·코드)을 같은 틀로 편집한다.
 * 검사는 editor-model.ts의 validateDraft가 하고, 오류가 있으면 「저장」이 꺼진다(원본 ed.invalid).
 */
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { blankRow, draftBlocks, type DraftCheck, type EditorDraft, type Row } from './editor-model.ts';
import { COLSETS, DESIGN, editGrid, SELECT_OPTIONS } from './labels.ts';

export interface StructuredEditorProps {
  title: string;
  sub: string;
  draft: EditorDraft;
  check: DraftCheck;
  busy: boolean;
  onChange: (draft: EditorDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}

export function StructuredEditor({ title, sub, draft, check, busy, onChange, onCancel, onSave }: StructuredEditorProps) {
  const invalid = check.errs.length > 0;
  const fields = draft.kind === 'ent' && draft.sec ? DESIGN[draft.sec].ent?.fields ?? [] : [];
  const setField = (k: string, v: string) => { onChange({ ...draft, f: { ...draft.f, [k]: v } }); };
  const setBlock = (k: string, v: Row[] | string) => { onChange({ ...draft, b: { ...draft.b, [k]: v } }); };
  const rows = (k: string) => (Array.isArray(draft.b[k]) ? (draft.b[k] as Row[]) : []);
  const actions = (
    <>
      <button type="button" className="btn" onClick={onCancel} disabled={busy}>취소</button>
      <BusyButton busy={busy} busyLabel="저장 중…" disabled={invalid} onClick={onSave}>저장</BusyButton>
    </>
  );
  return (
    <div className="pane edp" role="form" aria-label={title}>
      <div className="pane-h edp-h">
        <div><h3>{title}</h3><span className="muted">{sub}</span></div>
        <span style={{ display: 'flex', gap: 6 }}>{actions}</span>
      </div>
      {invalid && (
        <div className="banner danger" style={{ margin: '0 0 14px' }} role="alert">
          <div className="banner-b"><b>{check.errs.length}건</b> — 아래 항목을 고치면 저장할 수 있습니다.
            <ul className="lst" style={{ margin: '4px 0 0', color: 'inherit' }}>{check.errs.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        </div>
      )}
      {fields.length > 0 && (
        <div className="form" style={{ marginBottom: 8 }}>
          {fields.map((fd) => (
            <div className="frow" key={fd.k}>
              <span className="flabel">{fd.l}{fd.req ? <span className="req">필수</span> : <span className="opt">선택</span>}</span>
              <div className="fctl">
                {fd.opts
                  ? <div className="seg" role="group" aria-label={fd.l}>{fd.opts.map((o) => <button type="button" key={o} aria-pressed={draft.f[fd.k] === o} onClick={() => { setField(fd.k, o); }}>{o}</button>)}</div>
                  : <input className={`inp ${fd.mono ? 'mono-in' : ''} ${check.fieldErr[fd.k] ? 'bad' : ''}`} value={draft.f[fd.k] ?? ''} placeholder={fd.ph} aria-label={fd.l} aria-invalid={check.fieldErr[fd.k] ?? false} onChange={(e) => { setField(fd.k, e.target.value); }} />}
              </div>
            </div>
          ))}
        </div>
      )}
      {draftBlocks(draft).map((bk) => {
        const cols = bk.cols ? COLSETS[bk.cols] ?? [] : [];
        const grid = editGrid(cols);
        const list = rows(bk.k);
        return (
          <div className="edblk" key={bk.k}>
            <div className="tsec-h"><h4>{bk.l}</h4>{bk.hint && <span className="fhint">{bk.hint}</span>}</div>
            {bk.t === 'table' && (
              <>
                <div className="gtb" style={{ marginBottom: 8 }} role="table" aria-label={bk.l}>
                  <div className="gtr h" style={{ gridTemplateColumns: grid }} role="row">
                    {cols.map((c) => <span key={c.k} className="gc" role="columnheader">{c.l}{c.req && <span className="req">*</span>}</span>)}<span className="gc" />
                  </div>
                  {list.map((r, ri) => {
                    const bad = check.rowErr[bk.k]?.[ri];
                    const setCell = (k: string, v: string | boolean) => { setBlock(bk.k, list.map((x, i) => (i === ri ? { ...x, [k]: v } : x))); };
                    return (
                      <div key={ri} className={`gtr ed ${bad ? 'bad' : ''}`} style={{ gridTemplateColumns: grid }} role="row">
                        {cols.map((c) => {
                          const aria = `${c.l} ${String(ri + 1)}행`;
                          const cls = bad?.[c.k] ? 'bad' : '';
                          const v = r[c.k];
                          return (
                            <span className="gc" key={c.k}>
                              {c.t === 'check' && <input type="checkbox" className={`chk ${cls}`} checked={!!v} aria-label={aria} onChange={(e) => { setCell(c.k, e.target.checked); }} />}
                              {c.t === 'sel' && c.sel && (
                                <select className="inp cellin" value={String(v ?? '')} aria-label={aria} onChange={(e) => { setCell(c.k, e.target.value); }}>
                                  {SELECT_OPTIONS[c.sel].map((o) => <option key={o} value={o}>{o}</option>)}
                                </select>
                              )}
                              {!c.t && <input className={`inp cellin ${c.mono ? 'mono-in' : ''} ${cls}`} value={typeof v === 'string' ? v : ''} placeholder={c.ph} aria-label={aria} aria-invalid={!!bad?.[c.k]} onChange={(e) => { setCell(c.k, e.target.value); }} />}
                            </span>
                          );
                        })}
                        <span className="gc"><button type="button" className="iconbtn sm" aria-label={`${String(ri + 1)}행 삭제`} title={`${String(ri + 1)}행 삭제`} onClick={() => { setBlock(bk.k, list.filter((_, i) => i !== ri)); }}><svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button></span>
                      </div>
                    );
                  })}
                  {!list.length && <div className="gtr"><span className="gc muted">행이 없습니다.</span></div>}
                </div>
                <button type="button" className="btn sm" onClick={() => { setBlock(bk.k, [...list, blankRow(bk.cols ?? '')]); }}>+ {bk.addL ?? '행 추가'}</button>
              </>
            )}
            {bk.t === 'lines' && <textarea rows={4} className="inp" aria-label={bk.l} value={typeof draft.b[bk.k] === 'string' ? (draft.b[bk.k] as string) : ''} onChange={(e) => { setBlock(bk.k, e.target.value); }} />}
            {bk.t === 'code' && <textarea rows={8} className="inp mono-in" aria-label={bk.l} value={typeof draft.b[bk.k] === 'string' ? (draft.b[bk.k] as string) : ''} onChange={(e) => { setBlock(bk.k, e.target.value); }} />}
          </div>
        );
      })}
      <div className="form-acts" style={{ marginTop: 18 }}>
        <span className="muted" style={{ marginRight: 'auto' }}>저장하면 이력에 변경 전/후가 기록됩니다. 다른 탭이나 Task로 이동하면 저장 여부를 묻습니다.</span>
        {actions}
      </div>
    </div>
  );
}
