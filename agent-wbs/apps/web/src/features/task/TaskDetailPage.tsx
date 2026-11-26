/**
 * 주소 `/wbs/:taskKey` 화면(임시 조립) — 원본 WBS 화면의 「레일 + 상세」 모양(P L803–810, G§4.3).
 *
 * coordinator 합의(2026-11-26): 레일·필터·표는 M3-02(features/wbs) 몫이다. M3-02가 병합하면 WbsPage가
 * 자기 레일 옆에 <TaskDetail>을 놓도록 이 파일을 대신한다. 그때까지 여기서는 필터 없는 최소 레일만 둔다.
 *
 * 주소 규칙
 * - 탭: `?tab=spec`(없으면 개요). 새로고침·뒤로 가기·공유에 탭이 남는다.
 * - 복귀 스택: 참조 링크로 옮길 때 history state `back`에 지금 Task를 쌓는다(「← TASK-xxxx로 돌아가기」).
 * - 키보드: ↑/K 이전, ↓/J 다음, Esc 펼치기(G§4.3 실제 구현). 입력 칸 안에서는 동작하지 않는다.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { MenuScreen } from '../../shared/layout/MenuScreen.tsx';
import { useApiQuery } from '../../shared/api/queries.ts';
import { statusOf } from './labels.ts';
import { isTabKey, TaskDetail, type TabKey } from './TaskDetail.tsx';

export function TaskDetailPage() {
  return <MenuScreen menu="wbs">{(project) => <TaskDetailScreen projectId={'id' in project ? String(project.id) : ''} />}</MenuScreen>;
}

function TaskDetailScreen({ projectId }: { projectId: string }) {
  const { taskKey = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const back = ((location.state as { back?: string[] } | null)?.back ?? []);
  const tabParam = search.get('tab');
  const tab: TabKey = isTabKey(tabParam) ? tabParam : 'overview';
  const list = useApiQuery('listTasks', { params: { projectId }, query: {} }, { topics: ['task', 'dependency'] });
  const [q, setQ] = useState('');

  const nodes = list.data?.nodes ?? [];
  const tasks = [...(list.data?.tasks ?? [])].filter((t) => !t.deletedAt).sort((a, b) => a.wbsPath.localeCompare(b.wbsPath, undefined, { numeric: true }));
  const ql = q.trim().toLowerCase();
  const shown = tasks.filter((t) => !ql || t.taskKey.toLowerCase().includes(ql) || t.title.toLowerCase().includes(ql));
  const flat = shown.map((t) => t.taskKey);
  const i = flat.indexOf(taskKey);
  const open = (key: string, ref: boolean) => {
    void navigate({ pathname: `/wbs/${key}`, search: tab === 'overview' ? '' : `?tab=${tab}` }, { state: { back: ref ? [...back, taskKey] : [] } });
  };
  const go = (k: number) => { const id = flat[i + k]; return id ? () => { open(id, false); } : undefined; };
  const prev = i > 0 ? go(-1) : undefined;
  const next = i >= 0 && i < flat.length - 1 ? go(1) : undefined;
  const backTo = back.at(-1) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('input,textarea,select,[contenteditable="true"],.overlay')) return;
      if ((e.key === 'ArrowUp' || e.key === 'k') && prev) { e.preventDefault(); prev(); }
      if ((e.key === 'ArrowDown' || e.key === 'j') && next) { e.preventDefault(); next(); }
      if (e.key === 'Escape') void navigate('/wbs');
    };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); };
  });

  // 레일: Work Package 구분선 + Task(P L808)
  const items: { wp?: string; key?: string }[] = [];
  let lastWp = '';
  for (const t of shown) {
    if (t.wbsNodeId !== lastWp) {
      const wp = nodes.find((n) => n.id === t.wbsNodeId);
      items.push({ wp: wp ? `${wp.wbsPath} ${wp.title}` : '' });
      lastWp = t.wbsNodeId;
    }
    items.push({ key: t.taskKey });
  }
  const byKey = new Map(tasks.map((t) => [t.taskKey, t]));

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1>WBS</h1>
          <p className="page-sub">{tasks.length} Tasks · Task ID는 고정, WBS 번호는 위치에 따라 자동 계산</p>
        </div>
      </div>
      <div className="split rail">
        <aside className="side wrail scrollc" aria-label="Task 목록">
          <div className="rail-h"><span className="rail-ttl">Task <span className="mono muted">{flat.length}</span></span>
            <button type="button" className="btn sm rail-exp" title="상세를 닫고 원래 목록으로 펼칩니다" onClick={() => { void navigate('/wbs'); }}>
              <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6" /></svg>펼치기
            </button>
          </div>
          <label className="search wr-search"><span className="sr">Task ID 또는 제목 검색</span><input type="search" placeholder="ID · 제목 검색" value={q} onChange={(e) => { setQ(e.target.value); }} /></label>
          {items.map((it, n) => {
            if (it.wp !== undefined) return <div className="wr-wp" key={`wp-${String(n)}`}>{it.wp}</div>;
            const t = byKey.get(it.key ?? '');
            if (!t) return null;
            const st = statusOf(String(t.lifecycleStatus));
            const cur = t.taskKey === taskKey;
            return (
              <button type="button" key={t.taskKey} className={cur ? 'side-i on' : 'side-i'} aria-current={cur ? 'true' : undefined} onClick={() => { open(t.taskKey, false); }}>
                <span className="side-r"><span className="mono muted">{t.taskKey}</span><span className={`st ${st.c}`}><span className="st-d" aria-hidden="true" />{st.l}</span></span>
                <span className="side-t">{t.title}</span>
              </button>
            );
          })}
          {list.data && !shown.length && <p className="empty" style={{ margin: '8px 4px' }}>조건에 맞는 Task가 없습니다.</p>}
        </aside>
        <TaskDetail
          key={taskKey}
          taskKey={taskKey} projectId={projectId} tab={tab}
          onTab={(next) => { setSearch(next === 'overview' ? {} : { tab: next }, { state: location.state as unknown }); }}
          nav={{
            posLabel: i >= 0 ? `${String(i + 1)} / ${String(flat.length)}` : '목록 밖 (필터에 맞지 않음)',
            onPrev: prev, onNext: next, backTo,
            onBack: () => { if (backTo) void navigate({ pathname: `/wbs/${backTo}`, search: location.search }, { state: { back: back.slice(0, -1) } }); },
          }}
          onOpenTask={open}
        />
      </div>
    </div>
  );
}
