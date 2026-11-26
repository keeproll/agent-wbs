/**
 * 1회용 로그인 링크(owner Q-01, contracts §2.4).
 * auth CLI가 `http://127.0.0.1:<port>/#login-token=<토큰>`을 만든다.
 * 토큰을 #(fragment) 뒤에 두는 이유: fragment는 서버 요청·접근 로그로 가지 않는다.
 */
const KEY = 'login-token';

/** location.hash에서 토큰을 꺼낸다. 토큰을 뺀 나머지 hash(`rest`)는 주소에 남긴다. */
export function readLoginToken(hash: string): { token: string; rest: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get(KEY);
  if (!token) return null;
  params.delete(KEY);
  const rest = params.toString();
  return { token, rest: rest ? `#${rest}` : '' };
}

export const DEFAULT_PATH = '/dashboard';

/**
 * 로그인 뒤 돌아갈 주소. 같은 앱 안의 경로만 허용한다.
 * 왜: `?next=//다른사이트`처럼 바깥 주소로 보내는 공격(open redirect)을 막는다.
 */
export function safeReturnPath(path: string | null | undefined): string {
  if (!path?.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return DEFAULT_PATH;
  if (path === '/login' || path.startsWith('/login?')) return DEFAULT_PATH;
  return path;
}
