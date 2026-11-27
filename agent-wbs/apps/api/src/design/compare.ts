import { designFieldDirection, type DesignShapeInput } from '@awbs/shared/api';

/** 계약→코드, 이전 계약→새 계약 모두 같은 규칙으로 비교한다(G§9.6-1-3). */
export function compareDesign(before?: DesignShapeInput | null, after?: DesignShapeInput | null, kind = '') {
  if (!before || !after) return { compat: 'unchecked' as const, changed: true };
  const old = new Map(before.fields.map(field => [field.path, field]));
  const current = new Map(after.fields.map(field => [field.path, field]));
  // 방향 규칙은 shared 한 곳에 둔다(Runner와 같은 사례 파일 contracts/fixtures/design-direction.json으로 시험).
  const direction = (path: string) => designFieldDirection(kind, path);
  const breaking = before.fields.some(field => {
    const next = current.get(field.path);
    if (!next) return direction(field.path) !== 'request';
    return next.type !== field.type || (direction(field.path) === 'response' ? field.required && !next.required : !field.required && next.required);
  }) || after.fields.some(field => !old.has(field.path) && field.required && direction(field.path) !== 'response');
  const changed = before.fields.length !== after.fields.length || before.fields.some(field => {
    const next = current.get(field.path);
    return !next || field.type !== next.type || field.required !== next.required;
  });
  return { compat: breaking ? 'breaking' as const : 'compatible' as const, changed };
}
