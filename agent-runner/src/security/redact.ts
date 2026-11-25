const MASK = '[REDACTED]';

// `tokensUsed`, `tokenSet`처럼 비밀이 아닌 값은 걸리지 않도록 끝만 본다.
const SECRET_KEY = /^(proxy-)?authorization$|cookie$|password$|passwd$|secret$|token$|api[-_]?key$|private[-_]?key$/i;

const PATTERNS: readonly [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`],
  [/\/bot\d+:[A-Za-z0-9_-]+/g, `/bot${MASK}`],
  // 경로에서 떨어져 나온 Telegram 토큰
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, MASK],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/g, MASK],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASK}@`],
  [/([?&](?:access_token|token|password|api_?key)=)[^&\s"']+/gi, `$1${MASK}`],
  // 문자열 안의 JSON·헤더·환경 변수(응답 본문, 명령 출력 등)
  [
    /("(?:(?:proxy-)?authorization|[\w-]*(?:cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key))"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    `$1"${MASK}"`,
  ],
  [/^((?:set-)?cookie|(?:proxy-)?authorization):\s*.+$/gim, `$1: ${MASK}`],
  [/\b([A-Z][A-Z0-9_]*_(?:TOKEN|PASSWORD|SECRET|KEY)|PASSWORD|TOKEN|SECRET)=[^\s"']+/g, `$1=${MASK}`],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
];

export type Redact = <T>(value: T) => T;

/** JSON으로 표현되는 값에서 비밀값을 가린다. `known`은 형식과 관계없이 항상 가릴 값이다. */
export function createRedactor(known: readonly string[] = []): Redact {
  // 짧은 값을 치환하면 무관한 글자까지 가려진다. 긴 값부터 치환해 일부만 남는 것을 막는다.
  const literals = known.filter((value) => value.length >= 8).sort((a, b) => b.length - a.length);

  const text = (input: string): string => {
    let output = input;
    for (const literal of literals) output = output.replaceAll(literal, MASK);
    for (const [pattern, replacement] of PATTERNS) output = output.replace(pattern, replacement);
    return output;
  };

  const walk = (value: unknown, key = ''): unknown => {
    if (value !== null && value !== undefined && SECRET_KEY.test(key)) return MASK;
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), walk(v, k)]));
    }
    return value;
  };

  return <T>(value: T) => walk(value) as T;
}
