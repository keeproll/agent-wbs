/** GitHub 연결 정상 = 네 권한을 모두 확인했고 부족한 것이 없음(contracts §3.1 github/status의 ok 규칙). 확인 못 함(null)은 정상이 아니다. */
export function githubOk(scopes: Record<string, unknown> | null): boolean {
  return scopes !== null && Object.values(scopes).every((value) => value !== 'missing');
}
