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
    if (key in properties) return unknownFields(properties[key], item, [...path, key]);
    return node.additionalProperties === false ? [[...path, key].join('.')] : [];
  });
}
