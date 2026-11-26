import { ProjectError } from './errors.ts';

export interface RepoRef { url: string; owner: string; name: string }

/**
 * GitHub 저장소 주소를 저장소까지만 받아 정규화한다(G§4.2, contracts §2.2).
 * 형식은 요청 스키마(RepoUrl)가 먼저 거르고, 여기서는 `.`·`..`처럼 저장소 이름이 될 수 없는 값을 거른다.
 */
export function parseRepoUrl(raw: string): RepoRef {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(raw);
  const owner = match?.[1];
  const name = match?.[2];
  // `.git`만 있는 주소는 lazy 매칭 때문에 이름이 `.git`으로 잡힌다. 저장소 이름이 아니므로 함께 거부한다.
  if (!owner || !name || name === '.' || name === '..' || name === '.git') {
    throw new ProjectError('VALIDATION_FAILED', { errors: [{ path: 'url', rule: 'repoUrl', message: '저장소 주소는 https://github.com/<owner>/<repo> 형식이어야 합니다.' }] });
  }
  return { url: `https://github.com/${owner}/${name}`, owner, name };
}
