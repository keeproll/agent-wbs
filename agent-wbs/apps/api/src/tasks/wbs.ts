import { wbsNumbers } from '@awbs/shared';

export interface NodeRow { id: string; kind: 'phase' | 'work_package'; parentId: string | null; sortOrder: number }
export interface TaskRow { id: string; wbsNodeId: string; sortOrder: number; deleted: boolean }

const bySort = <T extends { sortOrder: number; id: string }>(a: T, b: T) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1);

/** WBS 번호는 저장하지 않고 조회 때 계산한다(G§9.1-1). 삭제된 Task는 번호가 없다(빈 문자열). */
export function wbsPaths(nodes: readonly NodeRow[], tasks: readonly TaskRow[]) {
  const phases = nodes.filter((node) => node.kind === 'phase').sort(bySort).map((phase) => ({
    id: phase.id,
    wps: nodes.filter((node) => node.kind === 'work_package' && node.parentId === phase.id).sort(bySort).map((wp) => ({
      id: wp.id,
      tasks: tasks.filter((task) => task.wbsNodeId === wp.id && !task.deleted).sort(bySort).map((task) => task.id),
    })),
  }));
  const numbers = wbsNumbers(phases);
  const node = new Map([...numbers.phase, ...numbers.wp]);
  const task = new Map(tasks.map((item) => [item.id, numbers.task.get(item.id) ?? '']));
  return { node, task };
}
