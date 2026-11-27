/**
 * 보고서 제목에 쓰는 프로젝트 이름(M6-02, Codex 리뷰 P2·재리뷰 3·4차 P2-2).
 *
 * - 값은 스냅샷의 projectName만 쓴다. 지금의 프로젝트 이름으로 바꿔 넣지 않는다.
 * - projectNameStatus(이름의 출처)
 *   - snapshot: 생성할 때 기록한 이름(새 보고서).
 *   - filled: 옛 보고서에 마이그레이션 0047이 채운 이름(이름을 바꾼 적 없는 프로젝트라 지금 이름이 그때 이름).
 *   - unknown: 옛 보고서인데 이름을 바꾼 적이 있어 그때 이름을 알 수 없음(projectName = null). 「이름 미상(기존 보고서)」을 보인다.
 * - 계약에 맞지 않는 스냅샷(이름도 출처도 없음 등)을 읽어도 오류 대신 「프로젝트 이름 없음」을 보인다.
 *   왜: 보고서 이력은 언제든 열 수 있어야 한다. 이름 하나 때문에 화면·PDF가 실패하면 안 된다.
 */
export const NO_PROJECT_NAME = '프로젝트 이름 없음';
export const UNKNOWN_PROJECT_NAME = '이름 미상(기존 보고서)';

export function reportProjectName(snapshot: { projectName?: string | null; projectNameStatus?: string | null }): string {
  const name = snapshot.projectName;
  if (typeof name === 'string' && name.trim()) return name;
  return snapshot.projectNameStatus === 'unknown' ? UNKNOWN_PROJECT_NAME : NO_PROJECT_NAME;
}
