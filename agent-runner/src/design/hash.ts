import { createHash } from 'node:crypto';
import { record } from './shape.ts';

/** RFC 8785: JSON 숫자·문자열 표기는 JS와 같고 객체 키는 UTF-16 순서다. 잘못된 Unicode·숫자는 거부한다. */
function jcs(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JSON 숫자가 아닙니다.');
  if (typeof value === 'string' && !value.isWellFormed()) throw new Error('JSON 문자열이 아닙니다.');
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${jcs(k)}:${jcs(record(value)[k])}`).join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('JSON 값이 아닙니다.');
  return text;
}

function shape(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const fields = record(value).fields;
  if (!Array.isArray(fields)) throw new Error('필드 목록이 없습니다.');
  return { fields: [...fields].sort((a, b) => {
    const left = String(record(a).path), right = String(record(b).path);
    if (left !== right) return left < right ? -1 : 1;
    return jcs(a) < jcs(b) ? -1 : jcs(a) > jcs(b) ? 1 : 0;
  }) };
}

export function designItemHash(value: unknown): string {
  if (value === null) return createHash('sha256').update('null').digest('hex');
  const item = record(value);
  const content = { ...record(item.content) };
  for (const key of ['decisionKeys', 'tables', 'usedBy']) {
    const values = content[key];
    if (Array.isArray(values)) content[key] = [...values].sort();
  }
  const normalized = { itemKey: item.itemKey, kind: item.kind, path: item.path, name: item.name ?? null, description: item.description ?? null, taskKey: item.taskKey ?? null,
    content, contract: shape(item.contract), extracted: shape(item.extracted) };
  return createHash('sha256').update(jcs(normalized)).digest('hex');
}
