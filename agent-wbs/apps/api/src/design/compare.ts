import type { DesignShapeInput } from '@awbs/shared/api';

/** 계약→코드, 이전 계약→새 계약 모두 같은 규칙으로 비교한다(G§9.6-1-3). */
export function compareDesign(before?: DesignShapeInput | null, after?: DesignShapeInput | null) {
  if (!before || !after) return { compat: 'unchecked' as const, changed: true };
  const old = new Map(before.fields.map(field => [field.path, field]));
  const current = new Map(after.fields.map(field => [field.path, field]));
  const breaking = before.fields.some(field => {
    const next = current.get(field.path);
    return !next || next.type !== field.type || (!field.required && next.required);
  }) || after.fields.some(field => !old.has(field.path) && field.required);
  const changed = breaking || before.fields.length !== after.fields.length || before.fields.some(field => field.required !== current.get(field.path)?.required);
  return { compat: breaking ? 'breaking' as const : 'compatible' as const, changed };
}
