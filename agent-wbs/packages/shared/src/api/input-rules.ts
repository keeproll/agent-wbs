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

/**
 * GitHub 연결 상태 보고의 일관성(조정자 결정 2026-11-26, contracts §3.1).
 * - ok는 인증되고 missing 권한이 없을 때만 true다. 권한을 확인하지 못했으면(scopes null) ok는 false다.
 * - unverified(미확인) 권한이 있으면 화면에 띄울 warning이 필요하다.
 */
function githubStatusConsistent(body: unknown): InputError[] {
  const errors: InputError[] = [];
  const rule = 'githubStatusConsistent';
  const b = body as { ok?: unknown; scopes?: Record<string, unknown> | null; warning?: unknown } | null;
  if (typeof b !== 'object' || b === null) return errors;
  const values = b.scopes ? Object.values(b.scopes) : [];
  if (b.ok === true && b.scopes === null) {
    errors.push({ path: 'ok', rule, message: '권한을 확인하지 못했으면(scopes null) ok는 false여야 합니다.' });
  }
  if (b.ok === true && values.includes('missing')) {
    errors.push({ path: 'ok', rule, message: 'missing 권한이 있으면 ok는 false여야 합니다.' });
  }
  if (values.includes('unverified') && (typeof b.warning !== 'string' || b.warning.trim() === '')) {
    errors.push({ path: 'warning', rule, message: '확인하지 못한 권한(unverified)이 있으면 warning이 필요합니다.' });
  }
  return errors;
}

export const INPUT_RULES = { uniqueDesignKind, githubStatusConsistent } as const;
export type InputRule = keyof typeof INPUT_RULES;
