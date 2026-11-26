/**
 * 알림 링크(/change/CP-007 또는 /change/<uuid>)의 CP 한 건 찾기.
 *
 * 지금 계약에는 CP 한 건을 읽는 API가 없다(milestones M3-05 「알림 링크의 CP 찾기」).
 * 그래서 status 필터 없는 목록을 cursor로 끝까지 넘기며 찾는다. 한 번에 최대치(200건)를 읽는다.
 * 왜: 오래된 알림의 CP는 첫 쪽에 없을 수 있다. 첫 쪽만 보고 「없다」고 하면 팀장이 열 수 있는 CP를 못 연다.
 */
import { findInPages as findInCursorPages, PAGE_LIMIT, pageQuery } from '../../shared/api/allPages.ts';
import { ApiError, type ApiClient } from '../../shared/api/client.ts';
import type { Proposal } from './types.ts';

/** 한 쪽 크기(계약 최대 200). 공통 규칙(shared/api/allPages.ts)과 같은 값이다. */
export { PAGE_LIMIT };

type Lister<T> = (query: { limit: number; cursor?: string }) => Promise<{ items: readonly T[]; nextCursor: string | null }>;

/**
 * cursor 목록을 끝까지 넘기며 match에 맞는 항목을 찾는다. 끝까지 없으면 null.
 * CP(알림 링크)와 Planning 세션(출처 링크)이 같이 쓴다. 두 목록 모두 단건 조회 API가 없다.
 * M3 통합: 반복 규칙(같은 cursor 반복 시 멈춤·최대 쪽 수)은 공통 findInPages(shared/api/allPages.ts)가 한다. 여기서는 질의 모양만 맞춘다.
 */
export function findInPages<T>(list: Lister<T>, match: (item: T) => boolean): Promise<T | null> {
  return findInCursorPages((cursor) => list(pageQuery(cursor)), match);
}

/** ref가 CP 키(CP-007)인지 id인지 상관없이 맞는 CP를 돌려준다. 끝까지 없으면 null. */
export function findProposal<P extends Pick<Proposal, 'id' | 'cpKey'>>(list: Lister<P>, ref: string): Promise<P | null> {
  const wanted = ref.trim();
  const key = wanted.toUpperCase();
  return findInPages(list, (item) => item.id === wanted || item.cpKey.toUpperCase() === key);
}

/**
 * CP 한 건을 서버에서 읽는다(서버 후속 2차 GET /api/proposals/:id — ref는 내부 ID 또는 표시 키 CP-007). 없으면 null.
 * M3 통합: 단건 조회 API가 생겨 알림 링크·출처 링크의 CP는 목록을 끝까지 넘기지 않고 이것으로 찾는다.
 */
export async function getProposalOrNull(client: ApiClient, ref: string, signal?: AbortSignal): Promise<Proposal | null> {
  try {
    return await client.call('getProposal', { params: { id: ref.trim() }, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'notFound') return null;
    throw error;
  }
}
