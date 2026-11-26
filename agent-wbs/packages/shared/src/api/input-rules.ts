// JSON Schema로 나타낼 수 없는 입력 규칙. 형식 검증을 통과한 본문에 서버가 이어서 적용하고, 어기면 400 VALIDATION_FAILED다.

export interface InputError {
  path: string;
  rule: string;
  message: string;
}

/** 본문 안의 모든 add op의 `t.design`에서 같은 kind가 두 번 나오면 오류(조정자 결정 2026-11-26, data-model §2.4-1) */
function uniqueDesignKind(body: unknown): InputError[] {
  const errors: InputError[] = [];
  const visit = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => { visit(item, [...path, String(index)]); });
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    const design = (node.t as { design?: unknown } | undefined)?.design;
    if (node.op === 'add' && Array.isArray(design)) {
      const seen = new Set<unknown>();
      design.forEach((section: unknown, index) => {
        const kind = (section as { kind?: unknown } | null)?.kind;
        if (seen.has(kind)) {
          errors.push({ path: [...path, 't', 'design', String(index), 'kind'].join('.'), rule: 'uniqueDesignKind', message: `설계 종류 ${String(kind)}가 겹칩니다.` });
        }
        seen.add(kind);
      });
      return;
    }
    for (const [key, item] of Object.entries(node)) visit(item, [...path, key]);
  };
  visit(body, []);
  return errors;
}

export const INPUT_RULES = { uniqueDesignKind } as const;
export type InputRule = keyof typeof INPUT_RULES;
