/**
 * 주소(라우팅) 표. 메뉴 12개의 주소는 `/<메뉴 key>`다(shared/layout/menu.ts).
 * 하위 주소: `/wbs/:taskKey`(G§4.3), `/settings/:tab`(G§4.9).
 * M3-02~08은 feature 컴포넌트를 내보내고, 이 표에 연결하는 일은 병합 때 coordinator가 한다(shared/README §1).
 *
 * 편집 보호(useBlocker)를 쓰려면 data router(createBrowserRouter)가 필요하다.
 */
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { RequireAuth } from '../shared/auth/RequireAuth.tsx';
import { MENU } from '../shared/layout/menu.ts';
import { Shell } from '../shared/layout/Shell.tsx';
import { NotFoundPage, PendingPage } from './pages.tsx';
import { DashboardPage } from '../features/dashboard/DashboardPage.tsx';
import { HistoryPage } from '../features/history/HistoryPage.tsx';
import { VerifyPage } from '../features/verify/VerifyPage.tsx';

/** 구현을 마친 메뉴(M3-07: dashboard·verify·history). 나머지는 PendingPage. */
const DONE: Partial<Record<string, () => React.JSX.Element>> = { dashboard: DashboardPage, verify: VerifyPage, history: HistoryPage };

/** 공통 컴포넌트 견본(/_states). 개발 서버와 E2E 빌드에만 들어가고 제품 빌드에는 없다. */
const withSandbox = import.meta.env.DEV || import.meta.env.MODE === 'e2e';
const StatesSandbox = withSandbox ? lazy(() => import('./sandbox/StatesSandbox.tsx')) : null;

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth><Shell /></RequireAuth>,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      // key: 메뉴를 옮기면 화면을 새로 만든다. 같은 컴포넌트를 재사용하면 「재방문 갱신」(상단 진행 막대)이 일어나지 않는다.
      ...MENU.map((item) => {
        const Done = DONE[item.key];
        return { path: `/${item.key}`, element: Done ? <Done key={item.key} /> : <PendingPage key={item.key} menu={item.key} /> };
      }),
      { path: '/wbs/:taskKey', element: <PendingPage key="wbs" menu="wbs" /> },
      { path: '/settings/:tab', element: <PendingPage key="settings" menu="settings" /> },
      ...(StatesSandbox ? [{ path: '/_states', element: <Suspense><StatesSandbox /></Suspense> }] : []),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
