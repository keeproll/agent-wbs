/**
 * GitHub 연결 상태 읽기(GET /api/settings/github).
 *
 * 왜 useApiQuery를 쓰지 않나: 계약의 설정 요청은 `get${name}` 템플릿 문자열로 id를 만들어
 * TypeScript에서 id가 그냥 `string`이 된다. 그래서 `ResponseOf<'getGithubSettings'>`가 모든 설정 요청의 합집합(never)이 된다.
 * (@awbs/shared 결함 — 보고함. 고쳐지면 useApiQuery('getGithubSettings')로 바꾼다.)
 * 아래 모양은 packages/shared/src/api/routes/settings.ts 「GithubSettings」 read 필드를 그대로 옮긴 것이다.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ApiError } from '../../shared/api/client.ts';
import { apiKey } from '../../shared/api/queries.ts';

type Permission = 'verified' | 'unverified' | 'missing';
export interface GithubSettingsView {
  mode: 'gh' | 'token';
  tokenSet: boolean;
  status: string;
  account: string | null;
  scopes: { contents: Permission; pulls: Permission; statuses: Permission; metadata: Permission } | null;
  warning: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
}

export function useGithubSettings() {
  const { client } = useApi();
  return useQuery<GithubSettingsView, ApiError>({
    queryKey: apiKey('getGithubSettings' as never),
    queryFn: ({ signal }) => (client.call as unknown as (id: string, args: { signal: AbortSignal }) => Promise<GithubSettingsView>)('getGithubSettings', { signal }),
    meta: { topics: ['settings'] },
    retry: false,
  });
}
