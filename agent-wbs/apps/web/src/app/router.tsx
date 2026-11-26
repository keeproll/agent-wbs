/**
 * 주소(라우팅) 표. 메뉴 12개의 주소는 `/<메뉴 key>`다(shared/layout/menu.ts).
 * 하위 주소: `/wbs/:taskKey`(G§4.3), `/settings/:tab`(G§4.9).
 * M3-02~08은 각 메뉴의 `element`를 자기 화면으로 바꾼다. 다른 메뉴 줄은 건드리지 않는다.
 *
 * 편집 보호(useBlocker)를 쓰려면 data router(createBrowserRouter)가 필요하다.
 */
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { RequireAuth } from '../shared/auth/RequireAuth.tsx';
import { MENU } from '../shared/layout/menu.ts';
import { Shell } from '../shared/layout/Shell.tsx';
import { TaskDetailPage } from '../features/task/TaskDetailPage.tsx';
import { NotFoundPage, PendingPage } from './pages.tsx';

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
      ...MENU.map((item) => ({ path: `/${item.key}`, element: <PendingPage key={item.key} menu={item.key} /> })),
      // M3-03 Task 상세(임시 조립 — M3-02가 WbsPage에서 레일+TaskDetail로 대신한다. features/task/README.md)
      { path: '/wbs/:taskKey', element: <TaskDetailPage key="wbs-task" /> },
      { path: '/settings/:tab', element: <PendingPage key="settings" menu="settings" /> },
      ...(StatesSandbox ? [{ path: '/_states', element: <Suspense><StatesSandbox /></Suspense> }] : []),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
