import { Navigate, Route, Routes } from 'react-router';
import { MENU } from './menu.ts';
import { NotFoundPage, PendingPage } from './pages.tsx';
import { Shell } from './Shell.tsx';

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        {MENU.map((item) => (
          <Route key={item.key} path={`/${item.key}`} element={<PendingPage title={item.label} />} />
        ))}
        {/* 가이드가 정한 하위 주소(G§4.3, §4.9) */}
        <Route path="/wbs/:taskKey" element={<PendingPage title="WBS" />} />
        <Route path="/settings/:tab" element={<PendingPage title="설정" />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
