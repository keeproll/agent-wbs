/**
 * 메뉴 화면의 공통 바깥 틀. M3-02~08의 각 메뉴 화면은 이 안에 본문을 넣는다.
 *
 * 처리하는 것:
 * - 프로젝트 상태(GET /api/project)를 먼저 읽는다. 메뉴 잠금 판정에 필요하기 때문이다.
 * - 처음 열 때: 0.2초가 지나도 응답이 없으면 메뉴별 skeleton(SYS-01).
 * - 이미 본 데이터가 있으면: 이전 화면을 유지하고 상단 진행 막대만 켠다.
 * - 실패(응답 없음 10초·503 등): 메뉴 제목 + 오류 카드 + 다시 시도(UAT-STATE-04).
 * - 등록·초기 WBS 승인 전: 프로젝트·설정 외 메뉴는 잠금 안내(UAT-SHELL-02의 공통 부분).
 *
 * 쓰는 법:
 *   <MenuScreen menu="wbs">{(project) => <WbsBody projectId={project.id} />}</MenuScreen>
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../api/queries.ts';
import type { ResponseOf } from '../api/contract.ts';
import { LoadError } from '../ui/LoadError.tsx';
import { PageSkeleton, useDelayedFlag } from '../ui/loading.tsx';
import { useTopBar } from '../ui/feedback.tsx';
import { menuLabel, OPEN_BEFORE_ACTIVE, type MenuKey } from './menu.ts';
import { Page, useDocumentTitle } from './Page.tsx';

export type ProjectState = ResponseOf<'getProject'>;

/** 메뉴가 잠겼는지. 프로젝트 상태를 모르면(아직 못 읽음) 잠그지 않는다. */
export function isMenuLocked(menu: MenuKey, project: ProjectState | undefined): boolean {
  return project !== undefined && project.state !== 'active' && !OPEN_BEFORE_ACTIVE.includes(menu);
}

/** 잠긴 메뉴를 눌렀을 때 안내 문구(원본 P L6877 그대로) */
export function lockMessage(menu: MenuKey, project: ProjectState): string {
  return project.state === 'none'
    ? '먼저 프로젝트를 등록하세요. (등록 전에는 프로젝트 · 설정 메뉴만 사용할 수 있습니다)'
    : `초기 WBS를 승인하면 ${menuLabel(menu)} 메뉴를 사용할 수 있습니다.`;
}

/** 이 query가 화면을 연 뒤 처음 하는 갱신인데 이미 보여 줄 데이터가 있는가(= 재방문·필터 변경) */
export function useRevisitFetching(query: { isFetching: boolean; isPlaceholderData: boolean; dataUpdatedAt: number; data: unknown }): boolean {
  const [mountedAt] = useState(() => Date.now());
  return query.data !== undefined && query.isFetching && (query.isPlaceholderData || query.dataUpdatedAt < mountedAt);
}

export function MenuScreen({ menu, title, children }: { menu: MenuKey; title?: string; children: (project: ProjectState) => ReactNode }) {
  const label = title ?? menuLabel(menu);
  useDocumentTitle(label);
  const project = useApiQuery('getProject', {}, { topics: ['project'] });
  const skeleton = useDelayedFlag(project.isPending && project.fetchStatus === 'fetching');
  useTopBar(useRevisitFetching(project));

  if (project.isError && (project.data === undefined || project.isFetching === false)) {
    return <LoadError title={label} error={project.error} retrying={project.isFetching} onRetry={() => { void project.refetch(); }} />;
  }
  if (project.data === undefined) {
    return <div className="page scroll">{skeleton && <PageSkeleton menu={menu} />}</div>;
  }
  if (isMenuLocked(menu, project.data)) {
    return (
      <Page title={label}>
        <div className="banner info" role="note">
          <div className="banner-b">
            <b>{label} 메뉴는 아직 사용할 수 없습니다</b> — {lockMessage(menu, project.data)}
          </div>
        </div>
        <div className="form-acts" style={{ justifyContent: 'flex-start', borderTop: 0 }}>
          <Link className="btn primary" to="/project">프로젝트로 이동</Link>
        </div>
      </Page>
    );
  }
  return children(project.data);
}
