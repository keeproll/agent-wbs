/**
 * 인터페이스(UI-04-03·03A)·데이터(UI-04-04·04A) 탭 — 원본 P L1534–1582.
 * 목록 → 행을 누르면 왼쪽 레일 + 오른쪽 상세. 「펼치기」는 목록으로 돌아간다.
 *
 * - 목록 순서는 서버 순서(항목 key 순)를 그대로 쓴다.
 * - 상세는 GET …/interfaces/:key · …/data/:key로 읽는다. 해석기가 없는 형식(content=null)은 계약 파일 원문을 그대로 보인다(G L430).
 * - REST 「읽고 쓰는 테이블」 ↔ PostgreSQL 「사용하는 API」는 서로의 상세로 이동한다(UAT-DESIGN-03 a).
 * - 담당 Task는 Task 상세 주소(LINK.task)로 연결한다(UAT-DESIGN-03 b).
 */
import type { KeyboardEvent } from 'react';
import { Link, type SetURLSearchParams } from 'react-router';
import { useApiQuery } from '../../shared/api/queries.ts';
import { LINK } from '../../shared/links.ts';
import { useRefreshError } from '../../shared/layout/MenuScreen.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import type { DesignCtx } from './DesignPage.tsx';
import {
  driftView, itemRows, kindCounts, position, storeCounts, tableTarget, taskStat,
  type DataDetail, type DataItem, type IfaceDetail, type IfaceItem, type ItemRow, type TaskInfo,
} from './model.ts';

const STORE_NOTE: Record<string, string> = {
  postgres: 'API × 테이블 연결은 테이블 상세의 「사용하는 API」에서 확인',
  neo4j: '원본과 복제 관계(어느 저장소가 원본인지)는 소유권 · 흐름 탭에서 확인',
  questdb: '시계열 저장소 — 조건부 선호 결정이 승인된 경우에만 계약이 생깁니다.',
  redis: '키 패턴 · 용도 · 값 · TTL · 무효화 · 영속성 — 원본 데이터인지는 소유권 · 흐름 탭에서 확인',
};

export function ItemsTab({ ctx, which, items, tasks, params, setParams }: {
  ctx: DesignCtx; which: 'iface' | 'data'; items: readonly (IfaceItem | DataItem)[]; tasks: ReadonlyMap<string, TaskInfo>;
  params: URLSearchParams; setParams: SetURLSearchParams;
}) {
  const iface = which === 'iface';
  const kind = params.get('kind') ?? '';
  const storeParam = params.get('store') ?? '';
  const store = ['postgres', 'neo4j', 'questdb', 'redis'].includes(storeParam) ? storeParam : 'postgres';
  const q = params.get('q') ?? '';
  const sel = params.get('sel') ?? '';
  const rows = itemRows(items, iface ? { kind, q } : { store, q }, tasks, ctx.drifts);
  const selected = sel ? items.find((x) => x.key === sel) ?? null : null;
  const set = (patch: Record<string, string>, replace = false) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    }, { replace });
  };
  const listTitle = iface ? '인터페이스' : '데이터';
  const reset = () => { set({ kind: '', store: '', q: '', sel: '' }); };

  if (selected) {
    return (
      <div className="two">
        <aside className="side scrollc" aria-label={`${listTitle} 목록`}>
          <div className="rail-h">
            <span className="rail-ttl">{listTitle} <span className="mono muted">{rows.length}</span></span>
            <button type="button" className="btn sm rail-exp" onClick={() => { set({ sel: '' }); }} title="상세를 닫고 원래 목록으로 펼칩니다">
              <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6" /></svg>펼치기
            </button>
          </div>
          {rows.map((r) => (
            <button key={r.key} type="button" className={r.key === sel ? 'side-i on' : 'side-i'} aria-current={r.key === sel ? 'true' : undefined} onClick={() => { set({ sel: r.key }); }}>
              <span className="side-r"><span className="tag">{r.kindL}</span><span className={r.stC}>{r.stL}</span></span>
              <span className="side-t mono" style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{r.name}</span>
            </button>
          ))}
        </aside>
        <div className="mainc">
          <Detail ctx={ctx} iface={iface} item={selected} rows={rows} tasks={tasks} go={(key) => { set({ sel: key }); }}
            open={(tab, key) => { setParams(tab === 'data' ? { tab, store: key.slice(0, key.indexOf(':')), sel: key } : { tab, sel: key }); }} />
        </div>
      </div>
    );
  }

  const counts = iface ? kindCounts(items as IfaceItem[]) : storeCounts(items as DataItem[]);
  const current = iface ? kind : store;
  const total = items.length;
  return (
    <>
      <div className="ds-bar">
        <div className="seg" role="group" aria-label={iface ? '방식' : '저장소'}>
          {counts.map(([k, l, n]) => (
            <button key={k || 'all'} type="button" aria-pressed={current === k} onClick={() => { set(iface ? { kind: k, sel: '' } : { store: k === 'postgres' ? '' : k, sel: '' }); }}>{l} {n}</button>
          ))}
        </div>
        <label className="search"><span className="sr">검색</span><input type="search" placeholder="이름 · 설명 검색" value={q} onChange={(e) => { set({ q: e.target.value, sel: '' }, true); }} /></label>
      </div>
      {!iface && <p className="fhint" style={{ margin: '0 0 8px' }}>{STORE_NOTE[store]}</p>}
      <div className="card" style={{ padding: 0 }}>
        <div className="gtb" style={{ margin: 0 }}>
          <div className="gtr h dsrow"><span className="gc">종류</span><span className="gc">이름</span><span className="gc">설명</span><span className="gc">상태</span><span className="gc">담당 Task</span></div>
          {rows.length === 0 && (total === 0 ? (
            <div className="gtr" data-empty="none"><span className="gc muted">{iface
              ? '아직 인터페이스 계약이 없습니다. 계약 설계 Task가 계약 파일을 main에 병합하면 여기에 나타납니다.'
              : '아직 데이터 계약이 없습니다. 계약 설계 Task가 스키마 · 모델 파일을 main에 병합하면 여기에 나타납니다.'}</span></div>
          ) : (
            <div className="gtr" data-empty="filtered"><span className="gc muted">{iface ? '조건에 맞는 인터페이스가 없습니다.' : '조건에 맞는 항목이 없습니다.'}{' '}
              <button type="button" className="btn ghost sm" onClick={reset}>필터 초기화</button></span></div>
          ))}
          {rows.map((r) => <Row key={r.key} r={r} onPick={() => { set({ sel: r.key }); }} />)}
        </div>
      </div>
    </>
  );
}

function Row({ r, onPick }: { r: ItemRow; onPick: () => void }) {
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } };
  return (
    <div className="gtr dsrow" role="button" tabIndex={0} data-row={r.key} onClick={onPick} onKeyDown={onKey}>
      <span className="gc"><span className="tag">{r.kindL}</span></span>
      <span className="gc mono ds-name">{r.name}{r.mark && <> <span className={r.mark[1]}>{r.mark[0]}</span></>}</span>
      <span className="gc muted">—</span>
      <span className="gc"><span className={r.stC}>{r.stL}</span>{r.fileError && <> <span className="sc sc-bad" title="계약 파일 읽기 실패 — 마지막 성공 버전">읽기 실패</span></>}</span>
      <span className="gc mono">{r.task}</span>
    </div>
  );
}

const KV = ({ cols = 110, children }: { cols?: number; children: React.ReactNode }) => (
  <div className="kv" style={{ gridTemplateColumns: `${String(cols)}px minmax(0,1fr)`, margin: '0 0 10px' }}>{children}</div>
);

function Detail({ ctx, iface, item, rows, tasks, go, open }: {
  ctx: DesignCtx; iface: boolean; item: IfaceItem | DataItem; rows: readonly ItemRow[]; tasks: ReadonlyMap<string, TaskInfo>;
  go: (key: string) => void; open: (tab: 'iface' | 'data', key: string) => void;
}) {
  const args = { params: { projectId: ctx.projectId, key: item.key }, query: {} };
  const ifaceQ = useApiQuery('getInterface', args, { topics: ['design'], enabled: iface, keepPrevious: false });
  const dataQ = useApiQuery('getDataItem', args, { topics: ['design'], enabled: !iface, keepPrevious: false });
  const query = iface ? ifaceQ : dataQ;
  useRefreshError(query, `${item.name} 상세 최신 내용 불러오기`);
  const pos = position(rows, item.key);
  const [stL, stC] = taskStat(item.taskKey ? tasks.get(item.taskKey) : undefined);
  const drifts = ctx.drifts.filter((d) => d.itemKey === item.key);
  const kindL = 'kind' in item ? item.kind : (rows.find((r) => r.key === item.key)?.kindL ?? item.store);
  const detail = query.data;
  const content = detail?.content ?? null;
  const shownKind = content && 'type' in content && content.type === 'neo4j-label' ? 'Neo4j 라벨' : content && 'type' in content && content.type === 'neo4j-relation' ? 'Neo4j 관계' : kindL;
  return (
    <div className="card" role="region" aria-label={`${item.name} 상세`}>
      <div className="vf-nav">
        <span className="tag">{shownKind}</span><span className={stC}>{stL}</span><span className="sp" />
        <span className="muted mono" style={{ fontSize: 12 }}>{pos.i >= 0 ? pos.label : `— / ${String(rows.length)}`}</span>
        <button type="button" className="btn ghost sm" disabled={!pos.prev} onClick={() => { if (pos.prev) go(pos.prev); }}>↑ 이전</button>
        <button type="button" className="btn ghost sm" disabled={!pos.next} onClick={() => { if (pos.next) go(pos.next); }}>↓ 다음</button>
      </div>
      <h2 className="mono" style={{ margin: '0 0 4px', fontSize: 18, wordBreak: 'break-all' }}>{item.name}</h2>
      {/* 원본 설명 줄 자리. 계약에 설명이 없어 이름과 다른 고정 키만 보이고, 없으면 빈 줄로 자리를 지킨다(아래 배치가 원본과 같게). */}
      <p className="muted" style={{ margin: '0 0 10px' }}>{item.key !== item.name ? item.key : '\u00a0'}</p>
      <div className="kv" style={{ gridTemplateColumns: '110px minmax(0,1fr)', margin: '0 0 12px' }}>
        <span className="kv-l">계약 파일</span>
        <span className="kv-v mono">{detail ? `${detail.source.path}${detail.source.commit ? ` · ${detail.source.commit.slice(0, 7)}` : ''}` : '—'}{detail?.source.status === 'error' && <> <span className="sc sc-bad">읽기 실패 — 마지막 성공 버전</span></>}</span>
        <span className="kv-l">담당 Task</span>
        <span className="kv-v">{item.taskKey ? <Link className="reflink mono" to={LINK.task(item.taskKey)}>{item.taskKey}</Link> : '—'}</span>
      </div>
      {drifts.length > 0 && (
        <div className="banner warn"><div className="banner-b">
          {drifts.map((d) => { const v = driftView(d); return <div key={d.id}><span className={v.stC}>{v.stL}</span> {d.text} <span className="tid">({d.where})</span> <span className={v.compatC}>{v.compatL}</span></div>; })}
        </div></div>
      )}
      {query.data === undefined && query.isError && <LoadError title={`${item.name} 상세`} error={query.error} retrying={query.isFetching} onRetry={() => { void query.refetch(); }} />}
      {query.data === undefined && !query.isError && <AreaLoading label="상세 불러오는 중" />}
      {detail && content === null && (
        <>
          <p className="fhint" style={{ margin: '0 0 6px' }}>해석기가 없는 형식입니다 — 계약 파일 원문을 그대로 보여 줍니다.</p>
          <pre className="code">{detail.source.raw ?? '(원문 없음)'}</pre>
        </>
      )}
      {detail && content !== null && <Content content={content as NonNullable<IfaceDetail['content'] | DataDetail['content']>} open={open} />}
    </div>
  );
}

function Content({ content, open }: { content: NonNullable<IfaceDetail['content'] | DataDetail['content']>; open: (tab: 'iface' | 'data', key: string) => void }) {
  switch (content.type) {
    case 'REST': {
      const tables = tableTarget(content.tables);
      return (
        <>
          <KV><span className="kv-l">인증</span><span className="kv-v">{content.auth || '—'}</span></KV>
          <h3 className="ds-h4">요청</h3><pre className="code">{content.request || '(없음)'}</pre>
          <h3 className="ds-h4">응답</h3><pre className="code">{content.response || '—'}</pre>
          {content.validation.length > 0 && <><h3 className="ds-h4">검증 규칙</h3><ul className="ds-ul">{content.validation.map((v) => <li key={v}>{v}</li>)}</ul></>}
          {content.errors.length > 0 && (
            <><h3 className="ds-h4">오류 코드</h3><div className="gtb" style={{ margin: '0 0 10px' }}>{content.errors.map((e) => (
              <div key={`${e.http}${e.code}`} className="gtr" style={{ gridTemplateColumns: '70px minmax(160px,1fr) minmax(160px,1.4fr)', minWidth: 0 }}><span className="gc mono">{e.http}</span><span className="gc mono">{e.code}</span><span className="gc">{e.cond}</span></div>
            ))}</div></>
          )}
          {tables.length > 0 && <><h3 className="ds-h4">읽고 쓰는 테이블</h3><div className="ds-chips">{tables.map((t) => <button key={t.key} type="button" className="btn ghost sm mono" onClick={() => { open('data', t.key); }}>{t.n}</button>)}</div></>}
        </>
      );
    }
    case 'message':
      return (
        <>
          <KV><span className="kv-l">인증</span><span className="kv-v">{content.auth || '—'}</span></KV>
          <h3 className="ds-h4">메시지</h3>
          <div className="gtb" style={{ margin: '0 0 10px' }}>{content.messages.map((m) => (
            <div key={m.name} className="gtr" style={{ gridTemplateColumns: 'minmax(130px,.8fr) 148px minmax(200px,2fr)', minWidth: 0 }}><span className="gc mono"><b>{m.name}</b></span><span className="gc">{m.direction}</span><span className="gc mono" style={{ fontSize: 12 }}>{m.schema}</span></div>
          ))}</div>
          {content.topic && (
            <><h3 className="ds-h4">토픽 규칙</h3><KV cols={130}>
              <span className="kv-l">파티션 키</span><span className="kv-v">{content.topic.key}</span>
              <span className="kv-l">파티션 · 보관</span><span className="kv-v">{content.topic.partitions}개 · {content.topic.retention}</span>
              <span className="kv-l">전달 보장</span><span className="kv-v">{content.topic.delivery}</span>
              <span className="kv-l">실패 메시지</span><span className="kv-v mono">{content.topic.dlq}</span>
              <span className="kv-l">호환 규칙</span><span className="kv-v">{content.topic.compat}</span>
              <span className="kv-l">소비 그룹</span><span className="kv-v mono">{content.topic.consumers.join(', ')}</span>
            </KV></>
          )}
          {content.rules.length > 0 && <><h3 className="ds-h4">규칙</h3><ul className="ds-ul">{content.rules.map((v) => <li key={v}>{v}</li>)}</ul></>}
        </>
      );
    case 'postgres':
      return (
        <>
          <h3 className="ds-h4">컬럼</h3>
          <div className="gtb" style={{ margin: '0 0 10px' }}>
            <div className="gtr h colrow"><span className="gc">이름</span><span className="gc">타입</span><span className="gc">제약</span><span className="gc">참조 · 기본값</span><span className="gc">설명</span></div>
            {content.columns.map((c) => (
              <div key={c.name} className="gtr colrow"><span className="gc mono"><b>{c.name}</b></span><span className="gc mono">{c.type}</span>
                <span className="gc">{[c.pk ? 'PK' : '', c.unique ? 'UNIQUE' : '', c.nullable ? 'NULL' : 'NOT NULL'].filter(Boolean).join(' · ')}</span>
                <span className="gc mono">{c.fk ?? ''} {c.default ?? ''}</span><span className="gc">{c.desc}</span></div>
            ))}
          </div>
          {content.constraints.length > 0 && <><h3 className="ds-h4">제약</h3><ul className="ds-ul mono">{content.constraints.map((v) => <li key={v}>{v}</li>)}</ul></>}
          {content.indexes.length > 0 && <><h3 className="ds-h4">인덱스</h3><ul className="ds-ul mono">{content.indexes.map((x) => <li key={x.name}>{`${x.name} (${x.columns}) ${x.kind}`}</li>)}</ul></>}
          <h3 className="ds-h4">사용하는 API</h3>
          {content.usedBy.length > 0
            ? <div className="ds-chips">{content.usedBy.map((n) => <button key={n} type="button" className="btn ghost sm mono" onClick={() => { open('iface', n); }}>{n}</button>)}</div>
            : <p className="muted" style={{ margin: 0 }}>이 테이블을 쓰는 API가 계약에 없습니다.</p>}
        </>
      );
    case 'neo4j-label':
      return (
        <>
          <KV><span className="kv-l">속성</span><span className="kv-v mono">{content.props}</span><span className="kv-l">비고</span><span className="kv-v">{content.note}</span></KV>
          <h3 className="ds-h4">제약</h3>
          {content.constraints.length > 0 ? <ul className="ds-ul mono">{content.constraints.map((v) => <li key={v}>{v}</li>)}</ul> : <p className="muted" style={{ margin: 0 }}>없음</p>}
        </>
      );
    case 'neo4j-relation':
      return <KV><span className="kv-l">시작 라벨</span><span className="kv-v mono">:{content.from}</span><span className="kv-l">끝 라벨</span><span className="kv-v mono">:{content.to}</span><span className="kv-l">속성</span><span className="kv-v mono">{content.props || '없음'}</span></KV>;
    case 'questdb':
      return (
        <KV cols={150}>
          <span className="kv-l">기준 타임스탬프</span><span className="kv-v mono">{content.timestamp}</span><span className="kv-l">파티션</span><span className="kv-v">{content.partition}</span>
          <span className="kv-l">보관 기간</span><span className="kv-v">{content.retention}</span><span className="kv-l">중복 제거 키</span><span className="kv-v mono">{content.dedup}</span>
          <span className="kv-l">SYMBOL 컬럼</span><span className="kv-v mono">{content.symbols}</span><span className="kv-l">값 컬럼</span><span className="kv-v mono">{content.columns}</span>
          <span className="kv-l">수집</span><span className="kv-v">{content.ingest}</span><span className="kv-l">집계</span><span className="kv-v">{content.aggregation}</span>
        </KV>
      );
    case 'redis':
      return (
        <KV>
          <span className="kv-l">용도</span><span className="kv-v">{content.use}</span><span className="kv-l">값</span><span className="kv-v mono">{content.value}</span>
          <span className="kv-l">만료</span><span className="kv-v">{content.ttl}</span><span className="kv-l">무효화</span><span className="kv-v">{content.invalidation}</span>
          <span className="kv-l">영속성</span><span className="kv-v">{content.persistence}</span>
        </KV>
      );
    default:
      return null;
  }
}
