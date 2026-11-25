import { useEffect, type ReactNode } from 'react';

function Page({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — Agent WBS`;
  }, [title]);
  return (
    <div className="page">
      <h1>{title}</h1>
      <div className="card">{children}</div>
    </div>
  );
}

/** 아직 만들지 않은 화면임을 그대로 알린다(G§9.7-3). */
export function PendingPage({ title }: { title: string }) {
  return (
    <Page title={title}>
      <p>이 화면은 아직 구현되지 않았습니다.</p>
    </Page>
  );
}

export function NotFoundPage() {
  return (
    <Page title="페이지를 찾을 수 없습니다">
      <p>주소를 확인하거나 왼쪽 메뉴에서 화면을 선택하세요.</p>
    </Page>
  );
}
