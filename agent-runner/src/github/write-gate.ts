import { sameRepository } from '../cleanup/remote.ts';
import { GitHubError, type WriteOperation } from './client.ts';

/**
 * 앱이 GitHub 클라이언트의 `beforeWrite`에 거는 쓰기 관문(M4). 모든 외부 쓰기(REST·Git push)가 같은 함수를 지난다.
 * - Git push(`branch_push`): push할 원격이 설정한 GitHub 저장소인지 먼저 확인한다.
 * - 그다음 배포 키 검사(승인하지 않은 deploy key가 있거나 목록을 확인할 수 없으면 거부)를 한다.
 * 왜: 원격이나 키를 확인할 수 없으면 쓰기를 중단한다는 M4 규칙을 push에도 똑같이 적용하기 위해서다.
 */
export function githubWriteGate(repository: string, checkDeployKeys: () => Promise<void>): (operation: WriteOperation) => Promise<void> {
  return async (operation) => {
    if (operation.kind === 'branch_push' && !sameRepository(operation.remote, repository)) {
      throw new GitHubError('push할 원격이 GitHub 설정의 저장소와 다릅니다. 쓰기를 중단합니다.', -1, false);
    }
    await checkDeployKeys();
  };
}
