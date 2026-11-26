import { describe, expect, it } from 'vitest';
import { findProposal } from '../src/features/change/find.ts';

const cp = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, cpKey: `CP-${String(n).padStart(3, '0')}` });

/** 200건씩 끊어 주는 가짜 목록. 받은 query를 기록한다. */
function pages(total: number) {
  const seen: { cursor?: string; limit?: number; status?: unknown }[] = [];
  const all = Array.from({ length: total }, (_, i) => cp(total - i));
  const list = (query: { cursor?: string; limit?: number; status?: unknown }) => {
    seen.push(query);
    const offset = query.cursor ? Number(query.cursor) : 0;
    const limit = query.limit ?? 50;
    const items = all.slice(offset, offset + limit);
    return Promise.resolve({ items, nextCursor: offset + limit < all.length ? String(offset + limit) : null });
  };
  return { list, seen };
}

describe('알림 링크의 CP 찾기(M3-05: 첫 쪽에 없다고 「없음」으로 처리하지 않는다)', () => {
  it('status 필터 없이 cursor를 끝까지 넘겨 오래된 CP를 찾는다', async () => {
    const { list, seen } = pages(450);
    const found = await findProposal(list, 'CP-002');
    expect(found?.cpKey).toBe('CP-002');
    expect(seen.length).toBe(3);
    expect(seen.every((q) => q.status === undefined && q.limit === 200)).toBe(true);
  });
  it('id(uuid)로도 찾는다', async () => {
    const { list } = pages(5);
    expect((await findProposal(list, cp(3).id))?.cpKey).toBe('CP-003');
  });
  it('끝까지 봐도 없을 때만 null', async () => {
    const { list, seen } = pages(250);
    expect(await findProposal(list, 'CP-999')).toBeNull();
    expect(seen.length).toBe(2);
  });
  it('소문자 키도 같은 CP로 본다', async () => {
    const { list } = pages(3);
    expect((await findProposal(list, 'cp-001'))?.cpKey).toBe('CP-001');
  });
});
