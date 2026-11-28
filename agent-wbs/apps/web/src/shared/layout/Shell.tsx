/**
 * 앱 틀(UI-00) — 헤더 64px, 왼쪽 메뉴 180px(접으면 56px), 본문. 원본 P L646–673 구조와 클래스 그대로.
 *
 * 원본과 다른 점(제품 결정):
 * - 「Prototype · Mock 데이터」 표시와 Runner 연결 Mock 전환 버튼은 없다. Runner 상태는 서버 값을 보여 주기만 한다(UAT-SHELL-03).
 * - 메뉴는 주소(URL)와 연결된 링크다. 새로고침·뒤로 가기로 같은 화면이 열린다(MM-29).
 * - 오른쪽 끝에 로그아웃 버튼을 둔다(owner Q-01 로그인 추가에 따른 짝).
 */
import { useState, type MouseEvent } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useApi } from '../api/ApiProvider.tsx';
import { useChangeFeed } from '../api/changes.ts';
import { useApiQuery } from '../api/queries.ts';
import { MainFeedback, useMainDimmed, useNotice } from '../ui/feedback.tsx';
import { ICON, Icon } from '../ui/Icon.tsx';
import { useSave } from '../state/useSave.tsx';
import { MENU } from './menu.ts';
import { isMenuLocked, lockMessage } from './MenuScreen.tsx';

function RunnerStatus() {
  const runner = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  const online = runner.data?.connection.online;
  const label = runner.data ? (online ? '연결됨' : '연결 끊김') : runner.isError ? '상태 모름' : '확인 중';
  return (
    <NavLink to="/settings" className={online === false ? 'runner off' : 'runner'} title="Runner 연결 상태 — 설정에서 자세히 봅니다">
      <span className="dot" aria-hidden="true" style={online === undefined ? { background: 'var(--ln2)' } : undefined} />
      Runner {label}
    </NavLink>
  );
}

/** 로그아웃. 서버가 세션을 지운 것을 확인한 뒤에만 로그인 화면으로 간다. 실패하면 오류 막대와 다시 시도(독립 리뷰 eebac50 #6). */
function LogoutButton() {
  const { client, clearSession } = useApi();
  const navigate = useNavigate();
  const { save, busy } = useSave({
    target: '로그아웃',
    failTitle: '로그아웃하지 못했습니다',
    run: () => client.call('logout', {}),
    onSuccess: () => { clearSession(); void navigate('/login', { replace: true }); },
  });
  return (
    <button
      type="button"
      className="iconbtn"
      aria-label={busy ? '로그아웃 중' : '로그아웃'}
      title="로그아웃"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => { void save(); }}
    >
      <Icon d={ICON.logout} />
    </button>
  );
}

export function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  const project = useApiQuery('getProject', {}, { topics: ['project', 'planning', 'design', 'task'] });
  const notify = useNotice();
  const dimmed = useMainDimmed();
  useChangeFeed(true);
  const projectName = project.data === undefined ? '' : 'name' in project.data ? project.data.name : '등록된 프로젝트 없음';

  return (
    <div className="app">
      <a className="skip" href="#main">본문으로 건너뛰기</a>
      <header className="hdr">
        <div className="hdr-l">
          <button
            type="button"
            className="iconbtn"
            aria-label="메뉴 접기/펼치기"
            aria-expanded={!collapsed}
            aria-controls="nav"
            onClick={() => { setCollapsed(!collapsed); }}
          >
            <Icon d={ICON.menu} />
          </button>
          <div className="brand"><span className="logo" aria-hidden="true">AW</span><span>Agent WBS</span></div>
          <span className="hdr-sep" aria-hidden="true" />
          <div className="proj"><span className="proj-l">프로젝트</span><span className="proj-n">{projectName}</span></div>
        </div>
        <div className="hdr-r">
          <RunnerStatus />
          <span className="user"><span className="avatar" aria-hidden="true">팀</span>팀장</span>
          <LogoutButton />
        </div>
      </header>
      <div className="body">
        <nav id="nav" className={collapsed ? 'nav collapsed' : 'nav'} aria-label="주 메뉴">
          {MENU.map((item) => {
            const locked = isMenuLocked(item.key, project.data);
            const onLocked = (event: MouseEvent) => {
              event.preventDefault();
              if (project.data) notify(lockMessage(item.key, project.data));
            };
            return (
              <NavLink
                key={item.key}
                to={`/${item.key}`}
                className={({ isActive }) => ['nav-i', isActive ? 'on' : '', locked ? 'off' : ''].filter(Boolean).join(' ')}
                aria-label={item.label}
                aria-disabled={locked || undefined}
                title={locked ? `${item.label} — 프로젝트 등록 · 초기 WBS 승인 후 사용할 수 있습니다` : item.label}
                {...(locked ? { onClick: onLocked } : {})}
              >
                <Icon d={item.icon} />
                {!collapsed && (
                  <>
                    <span className="nav-l">{item.label}</span>
                    {/* 원본은 단계 표시 칸(.nav-ph)을 빈 채로 그린다(P L668, phase ''). 화면 모양을 맞추려고 그대로 둔다. */}
                    <span className="nav-ph" aria-hidden="true" />
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>
        <main id="main" className={dimmed ? 'main dim' : 'main'} tabIndex={-1}>
          <MainFeedback />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
