/**
 * 주소(라우팅) 표. 메뉴 12개의 주소는 `/<메뉴 key>`다(shared/layout/menu.ts).
 *
 * 하위 주소(알림·보고서 링크가 여는 상세)
 * - `/wbs/:taskKey` — WBS 레일 + Task 상세(G§4.3). `?tab=`으로 탭을 고른다.
 * - `/exec/:taskKey` — 작업 실행에서 그 Task(M3-06). `?att=`로 시도를 고른다.
 * - `/change/:cpRef` — 변경 제안 상세(CP 키 또는 id, M3-05).
 * - `/ci/:runId` — 빌드·통합 실행 상세(M7-05). 서버 알림 ref의 path와 같다.
 * - `/settings/:tab` — 설정 탭(G§4.9).
 * 모든 하위 주소의 해석 규칙(알림 링크 → 주소)은 shared/auth/login-link.ts 한 곳에 있다.
 *
 * 편집 보호(useBlocker)를 쓰려면 data router(createBrowserRouter)가 필요하다.
 */
import { lazy, Suspense, type ComponentType } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { CiPage } from '../features/ci/CiPage.tsx';
import { ChangePage } from '../features/change/ChangePage.tsx';
import { DashboardPage } from '../features/dashboard/DashboardPage.tsx';
import { ExecPage } from '../features/exec/ExecPage.tsx';
import { HistoryPage } from '../features/history/HistoryPage.tsx';
import { PlanningPage } from '../features/planning/PlanningPage.tsx';
import { ProjectPage } from '../features/project/ProjectPage.tsx';
import { SettingsPage } from '../features/settings/SettingsPage.tsx';
import { VerifyPage } from '../features/verify/VerifyPage.tsx';
import { WbsPage } from '../features/wbs/WbsPage.tsx';
import { RequireAuth } from '../shared/auth/RequireAuth.tsx';
import { MENU, type MenuKey } from '../shared/layout/menu.ts';
import { Shell } from '../shared/layout/Shell.tsx';
import { NotFoundPage, PendingPage } from './pages.tsx';

/** 공통 컴포넌트 견본(/_states). 개발 서버와 E2E 빌드에만 들어가고 제품 빌드에는 없다. */
const withSandbox = import.meta.env.DEV || import.meta.env.MODE === 'e2e';
const StatesSandbox = withSandbox ? lazy(() => import('./sandbox/StatesSandbox.tsx')) : null;

/**
 * 메뉴 화면(M3에서 만든 것). 여기에 없는 메뉴는 「준비 중」(PendingPage)을 보인다.
 * 왜 표로 두나: 메뉴 하나를 연결할 때 이 표에 한 줄만 더하면 되고, 주소 규칙은 아래 한 곳에 남는다.
 */
const SCREENS: Partial<Record<MenuKey, ComponentType>> = {
  dashboard: DashboardPage, // M3-07
  project: ProjectPage, // M3-04
  wbs: WbsPage, // M3-02(+ M3-03 상세)
  planning: PlanningPage, // M3-05
  exec: ExecPage, // M3-06
  verify: VerifyPage, // M3-07
  change: ChangePage, // M3-05
  history: HistoryPage, // M3-07
  ci: CiPage, // M7-05(/ci/:runId는 실행 상세)
  settings: SettingsPage, // M3-08(/settings는 기본 Runner 탭)
};

/**
 * 메뉴 화면 하나.
 * key: 메뉴를 옮기면 화면을 새로 만든다. 같은 컴포넌트를 재사용하면 「재방문 갱신」(상단 진행 막대)이 일어나지 않는다.
 */
function screen(key: MenuKey) {
  const Screen = SCREENS[key];
  return Screen ? <Screen key={key} /> : <PendingPage key={key} menu={key} />;
}

/**
 * 하위 주소(상세). 메뉴 주소와 **같은 화면·같은 key**로 그린다.
 * 왜: 목록에서 상세로, 상세에서 다른 상세로 옮겨도 화면을 새로 만들지 않아 필터·스크롤·편집 상태가 남는다.
 * - `/wbs/:taskKey`는 WBS 메뉴 줄의 자식이다(M3-02). WbsPage가 useMatch로 주소를 읽는다.
 * - 나머지는 형제 줄이다. 각 화면이 useParams로 주소를 읽는다(M3-05·06·08 승인 방식 그대로).
 */
const DETAIL: Partial<Record<MenuKey, string>> = {
  exec: '/exec/:taskKey', // M3-06 작업 실행에서 그 Task(`?att=`로 시도)
  change: '/change/:cpRef', // M3-05 알림 링크로 여는 CP 상세(CP 키 또는 id)
  ci: '/ci/:runId', // M7-05 알림 링크로 여는 CI 실행 상세(서버 path `/ci/<id>`)
  settings: '/settings/:tab', // G§4.9 설정 탭
};

function menuRoutes(key: MenuKey): RouteObject[] {
  if (key === 'wbs') return [{ path: '/wbs', element: screen('wbs'), children: [{ path: ':taskKey', element: null }] }];
  const detail = DETAIL[key];
  return [{ path: `/${key}`, element: screen(key) }, ...(detail ? [{ path: detail, element: screen(key) }] : [])];
}

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth><Shell /></RequireAuth>,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      ...MENU.flatMap((item) => menuRoutes(item.key)),
      ...(StatesSandbox ? [{ path: '/_states', element: <Suspense><StatesSandbox /></Suspense> }] : []),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
