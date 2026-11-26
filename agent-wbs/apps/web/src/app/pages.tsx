import { MenuScreen } from '../shared/layout/MenuScreen.tsx';
import { Page } from '../shared/layout/Page.tsx';
import { menuLabel, type MenuKey } from '../shared/layout/menu.ts';

/**
 * 아직 만들지 않은 메뉴 화면(G§9.7-3). M3-02~08이 각 메뉴의 본문으로 바꾼다.
 * 바깥 틀(MenuScreen)은 그대로 써서 로딩·실패·잠금 처리를 공통으로 받는다.
 */
export function PendingPage({ menu }: { menu: MenuKey }) {
  return (
    <MenuScreen menu={menu}>
      {() => (
        <Page title={menuLabel(menu)}>
          <div className="card"><p style={{ margin: 0 }}>이 화면은 아직 구현되지 않았습니다.</p></div>
        </Page>
      )}
    </MenuScreen>
  );
}

/** 알 수 없는 주소(UAT-SHELL-05, MM-26). 원본의 「제작 예정」 대체 화면(UI-13)은 만들지 않는다. */
export function NotFoundPage() {
  return (
    <Page title="페이지를 찾을 수 없습니다">
      <div className="card">
        <p style={{ margin: 0 }}>주소를 확인하거나 왼쪽 메뉴에서 화면을 선택하세요. (404)</p>
      </div>
    </Page>
  );
}
