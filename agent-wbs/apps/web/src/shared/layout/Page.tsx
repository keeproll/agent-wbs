/**
 * 화면 한 장의 틀 — 원본 `.page.scroll` + `.page-h`(제목·설명·오른쪽 버튼).
 * 문서 제목(브라우저 탭)도 「<제목> — Agent WBS」로 맞춘다.
 */
import { useEffect, type ReactNode } from 'react';

export function useDocumentTitle(title: string): void {
  useEffect(() => { document.title = `${title} — Agent WBS`; }, [title]);
}

export interface PageProps {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export function Page({ title, sub, actions, children }: PageProps) {
  useDocumentTitle(title);
  return (
    <div className="page scroll">
      <div className="page-h">
        <div>
          <h1>{title}</h1>
          {sub && <p className="page-sub">{sub}</p>}
        </div>
        {actions && <div className="page-acts">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
