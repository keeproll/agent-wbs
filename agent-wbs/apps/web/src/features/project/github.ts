/**
 * GitHub 연결 상태 읽기(GET /api/settings/github, 계약 settings.ts 「GithubSettings」).
 * main(4ddd20d)에서 설정 요청 id 타입이 고쳐져 계약 타입을 그대로 쓴다.
 * 서버 구현은 아직 없다(서버 후속 작업). 그동안은 404가 오고, 화면은 「확인하지 못했습니다」를 보인다.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';
import { useApiQuery } from '../../shared/api/queries.ts';

export type GithubSettingsView = ResponseOf<'getGithubSettings'>;

export function useGithubSettings() {
  return useApiQuery('getGithubSettings', {}, { topics: ['settings'] });
}
