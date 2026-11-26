/**
 * 프로젝트 메뉴(/project). 프로젝트 상태에 따라 세 화면 중 하나를 보인다(G§4.2).
 * - none(등록 전): UI-02A 프로젝트 등록
 * - boot(초기 분석 중): UI-02B~D 초기 분석·기술 결정 확정·WBS 초안 승인
 * - active(진행 중): UI-02 프로젝트·UI-02E 입력 자료
 * 바깥 틀(MenuScreen)이 로딩·실패·잠금을 공통으로 처리한다.
 */
import { MenuScreen } from '../../shared/layout/MenuScreen.tsx';
import { ActiveView } from './ActiveView.tsx';
import { BootView } from './BootView.tsx';
import { RegisterView } from './RegisterView.tsx';

export function ProjectPage() {
  return (
    <MenuScreen menu="project">
      {(project) => {
        if ('bootstrap' in project) return <BootView key="boot" project={project} />;
        if ('approvedAt' in project) return <ActiveView key="active" project={project} />;
        return <RegisterView key={`none-${String(project.epoch)}`} project={project} />;
      }}
    </MenuScreen>
  );
}
