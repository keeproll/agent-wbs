const MASK = '[REDACTED]';
const secretKey = /authorization$|cookie$|pin$|password$|passwd$|secret$|token$|api[-_]?key$|private[-_]?key$/i;
// 일반 sort_key·primary_key는 보존하고 인증에 쓰는 이름만 가린다.
const secretName = '(?:(?:[a-z0-9]+[_-])*(?:token|pin|password|passwd|secret|api[-_]?key|private[-_]?key)|(?:bot|access|refresh)[-_]?token|AWBS_SECRET_KEY|AWS_(?:SECRET_ACCESS_KEY|ACCESS_KEY_ID))';
const assignment = `((?:(?<![\\w-])${secretName}["']?[ \\t]*[:=][ \\t]*|--${secretName}(?:=|[ \\t]+)))`;

export function redactText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`)
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, `/bot${MASK}`)
    .replace(/\b[0-9]{6,12}:[A-Za-z0-9_-]{20,}/g, MASK)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(/([?&#](?:[\w-]*(?:token|pin|password|secret)|api_?key)=)[^&\s"']+/gi, `$1${MASK}`)
    .replace(/("[\w-]*(?:authorization|cookie|pin|password|passwd|secret|token|api[-_]?key|private[-_]?key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, `$1"${MASK}"`)
    .replace(/^((?:set-)?cookie|(?:proxy-)?authorization):\s*.+$/gim, `$1: ${MASK}`)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/g, MASK)
    .replace(new RegExp(`${assignment}"(?:[^"\\\\]|\\\\.)*(?:"|$)`, 'gi'), `$1"${MASK}"`)
    .replace(new RegExp(`${assignment}'[^']*(?:'|$)`, 'gi'), `$1'${MASK}'`)
    .replace(new RegExp(`${assignment}(?:\\[REDACTED\\]|[^\\s"'&,;{}\\[\\]]+)`, 'gi'), `$1${MASK}`)
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

/** Runner의 글을 가린다. 계약 정의의 password 객체와 업로드 바이트는 보존한다. */
export function redactRunnerInput(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(redactRunnerInput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), secretKey.test(key) && typeof item === 'string' ? MASK : redactRunnerInput(item)]));
  return value;
}

/** 식별자·관측 경로는 다른 값으로 가려 저장하지 않고 호출자가 요청을 거부한다. */
export function changedRunnerReference(value: unknown, clean: unknown, key = ''): boolean {
  if (typeof value === 'string') return /(?:Id|Key|Hash|Sha|Commit)$|(?:^|_)(?:id|key|hash|sha|commit)$|^(?:ref|branch|path|from|changedFiles|artifacts|parents|cgroup|model|version|options|name)$/.test(key) && value !== clean;
  if (Buffer.isBuffer(value)) return false;
  if (Array.isArray(value)) return value.some((item, i) => changedRunnerReference(item, (clean as unknown[] | undefined)?.[i], key));
  if (value && typeof value === 'object') return Object.entries(value).some(([name, item]) => changedRunnerReference(item, (clean as Record<string, unknown> | undefined)?.[name], name));
  return false;
}
