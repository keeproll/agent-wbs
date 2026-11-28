const MASK = '[REDACTED]';
const secretKey = /authorization$|cookie$|password$|passwd$|secret$|token$|api[-_]?key$|private[-_]?key$/i;

export function redactText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`)
    .replace(/\/bot[^/\s"']+/g, `/bot${MASK}`)
    .replace(/\b[0-9]{6,12}:[A-Za-z0-9_-]{20,}/g, MASK)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(/([?&#](?:[\w-]*(?:token|password|secret)|api_?key)=)[^&\s"']+/gi, `$1${MASK}`)
    .replace(/("[\w-]*(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, `$1"${MASK}"`)
    .replace(/^((?:set-)?cookie|(?:proxy-)?authorization):\s*.+$/gim, `$1: ${MASK}`)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/g, MASK)
    .replace(/\b([\w-]*(?:TOKEN|PASSWORD|PASSWD|SECRET|_KEY|APIKEY|PRIVATEKEY))=(?:"(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$)|[^\s"']+)/gi, `$1=${MASK}`)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK);
}

/** 로그의 객체를 복사해 가린다. 순환 참조는 비밀값과 함께 원문 출력을 막는다. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) return { type: value.name, code: 'code' in value ? value.code : undefined, message: '내부 오류(원문 생략)' };
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), secretKey.test(key) ? MASK : redact(item, seen)]));
}
