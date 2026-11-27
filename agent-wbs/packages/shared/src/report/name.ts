/**
 * 보고서 제목에 쓰는 프로젝트 이름(M6-02, Codex 리뷰 P2).
 *
 * - 값은 스냅샷의 projectName(생성 시점 이름)만 쓴다. 지금의 프로젝트 이름으로 바꿔 넣지 않는다.
 * - 옛 보고서는 마이그레이션 0047이 이름을 채운다. 그래도 이름이 없는 스냅샷을 읽으면 오류 대신 「프로젝트 이름 없음」을 보인다.
 *   왜: 보고서 이력은 언제든 열 수 있어야 한다. 이름 하나 때문에 화면·PDF가 실패하면 안 된다.
 */
export const NO_PROJECT_NAME = '프로젝트 이름 없음';

export function reportProjectName(snapshot: { projectName?: string | null }): string {
  const name = snapshot.projectName;
  return typeof name === 'string' && name.trim() ? name : NO_PROJECT_NAME;
}
