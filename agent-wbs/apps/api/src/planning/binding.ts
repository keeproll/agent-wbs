import { boundJudgements } from '../tasks/hash.ts';
import { TaskError } from '../tasks/errors.ts';

/** 현재 계산값을 신뢰의 근거로 찍어 주지 않고, Runner가 판단한 지문과 대조한다. */
export function bindJudgements<T extends Parameters<typeof boundJudgements>[0]>(record: T, subjectHash: string | null | undefined, target: string) {
  try {
    if (!subjectHash) throw new Error('판단 대상 없음');
    return boundJudgements(record, subjectHash);
  } catch { throw new TaskError('VERSION_CONFLICT', { target, subjectHash: subjectHash ?? null, changes: [] }, [], '판단한 입력이 현재 판단 대상과 다릅니다.'); }
}
