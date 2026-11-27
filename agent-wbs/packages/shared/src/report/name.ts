/**
 * 보고서 제목에 쓰는 프로젝트 이름(M6-02, Codex 리뷰 P2·재리뷰 3차 P2-2).
 *
 * - 값은 스냅샷의 projectName(생성 시점 이름)만 쓴다. 지금의 프로젝트 이름으로 바꿔 넣지 않는다.
 * - 옛 보고서는 마이그레이션 0047이 다룬다.
 *   - 이름을 바꾼 적이 없는 프로젝트: 지금 이름을 넣는다(그때 이름과 같다).
 *   - 이름을 바꾼 적이 있는 프로젝트: 그때 이름을 알 수 없어 이름을 넣지 않고 projectNameFilled.source = 'unknown'을 남긴다.
 *     이때는 「이름 미상(기존 보고서)」을 보인다.
 * - 그 밖에 이름이 없는 스냅샷을 읽으면 오류 대신 「프로젝트 이름 없음」을 보인다.
 *   왜: 보고서 이력은 언제든 열 수 있어야 한다. 이름 하나 때문에 화면·PDF가 실패하면 안 된다.
 */
export const NO_PROJECT_NAME = '프로젝트 이름 없음';
export const UNKNOWN_PROJECT_NAME = '이름 미상(기존 보고서)';

export function reportProjectName(snapshot: { projectName?: string | null; projectNameFilled?: { source: string } | null }): string {
  const name = snapshot.projectName;
  if (typeof name === 'string' && name.trim()) return name;
  return snapshot.projectNameFilled?.source === 'unknown' ? UNKNOWN_PROJECT_NAME : NO_PROJECT_NAME;
}
