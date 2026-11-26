// 임시 방어: M2-01 담당이 앱 공통 validator(removeAdditional: false, 본문 타입 변환 끔)를 고치면
// 이 파일과 routes.ts의 preValidation 훅(「TEMP-STRICT」 표시)을 함께 지운다. 테스트는 그대로 통과해야 한다.
// Fastify 기본 검증기는 정의하지 않은 필드를 오류 대신 조용히 지운다(removeAdditional).
// 계약은 거부를 요구하므로(예: Task PATCH의 status) 검증 전에 원래 본문을 따로 검사한다.

interface Schema {
  type?: unknown;
  properties?: Record<string, Schema>;
  additionalProperties?: unknown;
  patternProperties?: unknown;
  items?: Schema;
  anyOf?: Schema[];
}

/** 스키마에 없는 필드의 경로 목록. 형식 오류(타입 등)는 Fastify 검증이 맡는다. */
export function unknownFields(schema: unknown, value: unknown, path: string[] = []): string[] {
  const node = (schema ?? {}) as Schema;
  if (node.anyOf) {
    const results = node.anyOf.map((branch) => unknownFields(branch, value, path));
    return results.find((found) => found.length === 0) ?? results[0] ?? [];
  }
  if (Array.isArray(value)) {
    return node.items ? value.flatMap((item, index) => unknownFields(node.items, item, [...path, String(index)])) : [];
  }
  if (!value || typeof value !== 'object' || !node.properties) return [];
  const properties = node.properties;
  return Object.entries(value).flatMap(([key, item]) => {
    // `in`은 toString 같은 상속 이름도 선언된 것으로 본다. 자기 속성만 인정한다.
    if (Object.hasOwn(properties, key)) return unknownFields(properties[key], item, [...path, key]);
    return node.additionalProperties === false ? [[...path, key].join('.')] : [];
  });
}
