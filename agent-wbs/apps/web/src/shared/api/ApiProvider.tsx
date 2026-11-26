/**
 * 앱 전체가 쓰는 API 연결·세션·서버 데이터 캐시를 한곳에서 제공한다.
 *
 * - `useApi()` → `{ client, session, lastSuccessAt }`.
 * - 세션은 `GET /api/session`으로 확인한다. 401이면 로그인 안 된 상태(null)다.
 * - 어떤 요청이든 401을 받으면 세션을 비워 로그인 화면으로 보낸다(RequireAuth).
 * - `#login-token=`이 붙은 주소로 열리면 토큰을 주소에서 즉시 지우고 1회용 링크 로그인을 한다(UAT-AUTH-02).
 */
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { readLoginToken } from '../auth/login-link.ts';
import { browserStorage, persistRegisteredDrafts } from '../state/sessionDrafts.ts';
import { ApiError, createApiClient, type ApiClient } from './client.ts';
import type { ResponseOf } from './contract.ts';

export type Session = ResponseOf<'getSession'>;

interface ApiContextValue {
  client: ApiClient;
  /** undefined = 아직 확인 중, null = 로그인 안 됨 */
  session: Session | null | undefined;
  /** 세션 확인 자체가 실패했을 때(서버 응답 없음 등) */
  sessionError: ApiError | null;
  /** 마지막으로 서버 응답을 성공적으로 받은 시각(ms). 「마지막으로 불러온 시각」 표시에 쓴다. */
  lastSuccessAt: number | null;
  /** 1회용 링크 로그인 결과. 실패하면 로그인 화면이 안내한다. */
  linkLogin: 'idle' | 'pending' | 'failed';
  refreshSession: () => Promise<unknown>;
  /** 로그아웃 성공 뒤 화면의 세션을 비운다(로그인 화면으로 이동하게 된다). */
  clearSession: () => void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function useApi(): ApiContextValue {
  const value = use(ApiContext);
  if (!value) throw new Error('ApiProvider 안에서만 쓸 수 있습니다.');
  return value;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // 실패를 자동으로 되풀이하지 않는다. 화면이 원인을 보여 주고 사용자가 「다시 시도」를 누른다(G§0.3).
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function ApiProvider({ children, queryClient }: { children: ReactNode; queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <QueryClientProvider client={client}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}

class CsrfStore {
  #value: string | null = null;
  get(): string | null { return this.#value; }
  set(value: string | null): void { this.#value = value; }
}

function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // CSRF 값 보관함. 화면 그리기와 상관없는 값이라 state로 두지 않는다.
  const [csrf] = useState(() => new CsrfStore());
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [linkLogin, setLinkLogin] = useState<ApiContextValue['linkLogin']>(() => (readLoginToken(location.hash) ? 'pending' : 'idle'));

  const client = useMemo<ApiClient>(() => {
    const inner = createApiClient({
      csrfToken: () => csrf.get(),
      onUnauthorized: () => {
        // 로그인된 상태에서 세션이 끊겼으면, 로그인 화면으로 가기 전에 편집 중 초안을 남긴다(조정자 결정).
        if (queryClient.getQueryData(['getSession', {}])) {
          const storage = browserStorage();
          if (storage) persistRegisteredDrafts(storage);
        }
        queryClient.setQueryData(['getSession', {}], null);
      },
    });
    return {
      call: async (id, args) => {
        const result = await inner.call(id, args);
        setLastSuccessAt(Date.now());
        return result;
      },
    };
  }, [csrf, queryClient]);

  // 1회용 링크: 토큰을 주소에서 먼저 지우고(뒤로 가기·공유로 새지 않게) 한 번만 보낸다.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    const found = readLoginToken(location.hash);
    if (!found) return;
    started.current = true;
    history.replaceState(history.state, '', `${location.pathname}${location.search}${found.rest}`);
    client.call('login', { body: { method: 'link', token: found.token } }).then(
      async () => { await queryClient.invalidateQueries({ queryKey: ['getSession'] }); setLinkLogin('idle'); },
      () => { setLinkLogin('failed'); },
    );
  }, [client, queryClient]);

  const sessionQuery = useQuery<Session | null, ApiError>({
    queryKey: ['getSession', {}],
    enabled: linkLogin !== 'pending',
    queryFn: async ({ signal }) => {
      try {
        return await client.call('getSession', { signal });
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'unauthorized') return null;
        throw error;
      }
    },
  });
  useEffect(() => { csrf.set(sessionQuery.data?.csrfToken ?? null); }, [csrf, sessionQuery.data]);

  const value = useMemo<ApiContextValue>(() => ({
    client,
    session: linkLogin === 'pending' ? undefined : sessionQuery.data,
    sessionError: sessionQuery.error,
    lastSuccessAt,
    linkLogin,
    refreshSession: () => sessionQuery.refetch(),
    clearSession: () => { queryClient.setQueryData(['getSession', {}], null); queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'getSession' }); },
  }), [client, linkLogin, sessionQuery, lastSuccessAt, queryClient]);

  return <ApiContext value={value}>{children}</ApiContext>;
}
