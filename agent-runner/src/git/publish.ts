/**
 * 결과 SHA push 원칙(M4-03 최종 확인 §3 연결 조건).
 *
 * PR에 보낼 커밋은 `importWorktree`가 돌려준 **결과 SHA**를 원격 Agent 브랜치로 직접 push한다.
 * Runner 로컬의 Agent 브랜치(`refs/heads/agent/...`)는 옮기지 않는다.
 * 왜: 로컬 브랜치는 복사 시작점(`startCommit`)을 가리켜야 `removeWorktree`가 이전 값 비교로 지울 수 있다.
 * 로컬 브랜치를 결과 SHA로 옮기면 정리 때 보존되어, 다음 시도에서 같은 브랜치 이름을 다시 쓸 수 없다.
 *
 * 예: 결과 SHA `abc…`, 브랜치 `agent/TASK-0001-h2` → `git push <등록 원격> abc…:refs/heads/agent/TASK-0001-h2`
 */
export function resultRefspec(resultSha: string, branch: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(resultSha)) throw new Error('결과 SHA는 전체 커밋 SHA여야 합니다.');
  if (!/^agent\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(branch)) throw new Error('Agent 브랜치(agent/…)만 보낼 수 있습니다.');
  return `${resultSha}:refs/heads/${branch}`;
}
