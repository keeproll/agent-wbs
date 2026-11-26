import { createHash } from 'node:crypto';

/**
 * 저장소 주소를 서버 DB(`reset_project`의 repo_key)와 같은 규칙으로 정규화한다.
 * 규칙: 앞뒤 공백 제거 → 끝의 `/` 제거 → 끝의 `.git` 제거(대소문자 무시) → 소문자.
 * 왜: 같은 저장소를 `https://github.com/O/R.git`와 `https://github.com/o/r/`로 적어도 하나로 봐야 한다.
 */
export function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

/**
 * Runner 로컬 저장소 이름(`repos/<이름>`). 정규화한 주소의 SHA-256 앞 16자리다 [결정].
 * clone하는 쪽과 초기화 정리가 이 함수 하나로 같은 이름을 쓴다.
 */
export function repositoryIdFor(url: string): string {
  return `r-${createHash('sha256').update(normalizeRepoUrl(url)).digest('hex').slice(0, 16)}`;
}
