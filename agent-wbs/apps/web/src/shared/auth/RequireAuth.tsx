/**
 * 로그인해야 볼 수 있는 화면을 감싼다.
 * 로그인 안 됐으면 `/login?next=<지금 주소>`로 보낸다. 로그인하면 그 주소로 돌아온다(UAT-AUTH-01).
 * 세션 확인 중에는 아무것도 그리지 않는다(보호 데이터를 먼저 보여 주지 않기 위해).
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useApi } from '../api/ApiProvider.tsx';
import { LoadError } from '../ui/LoadError.tsx';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, sessionError, refreshSession, linkLogin } = useApi();
  const location = useLocation();
  if (linkLogin === 'failed') return <Navigate to="/login?link=failed" replace />;
  if (session === undefined) {
    if (sessionError) return <LoadError title="Agent WBS" error={sessionError} retrying={false} onRetry={() => { void refreshSession(); }} />;
    return null;
  }
  if (session === null) {
    const next = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}
