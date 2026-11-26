/**
 * 알림 링크(/change/CP-007 또는 /change/<uuid>)의 CP 한 건 찾기.
 *
 * 지금 계약에는 CP 한 건을 읽는 API가 없다(milestones M3-05 「알림 링크의 CP 찾기」).
 * 그래서 status 필터 없는 목록을 cursor로 끝까지 넘기며 찾는다. 한 번에 최대치(200건)를 읽는다.
 * 왜: 오래된 알림의 CP는 첫 쪽에 없을 수 있다. 첫 쪽만 보고 「없다」고 하면 팀장이 열 수 있는 CP를 못 연다.
 */
import type { Proposal } from './types.ts';

export const PAGE_LIMIT = 200;

type Lister<T> = (query: { limit: number; cursor?: string }) => Promise<{ items: readonly T[]; nextCursor: string | null }>;

/**
 * cursor 목록을 끝까지 넘기며 match에 맞는 항목을 찾는다. 끝까지 없으면 null.
 * CP(알림 링크)와 Planning 세션(출처 링크)이 같이 쓴다. 두 목록 모두 단건 조회 API가 없다.
 */
export async function findInPages<T>(list: Lister<T>, match: (item: T) => boolean): Promise<T | null> {
  let cursor: string | undefined;
  for (;;) {
    const page = await list(cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor });
    const hit = page.items.find(match);
    if (hit) return hit;
    if (!page.nextCursor) return null;
    cursor = page.nextCursor;
  }
}

/** ref가 CP 키(CP-007)인지 id인지 상관없이 맞는 CP를 돌려준다. 끝까지 없으면 null. */
export function findProposal<P extends Pick<Proposal, 'id' | 'cpKey'>>(list: Lister<P>, ref: string): Promise<P | null> {
  const wanted = ref.trim();
  const key = wanted.toUpperCase();
  return findInPages(list, (item) => item.id === wanted || item.cpKey.toUpperCase() === key);
}
