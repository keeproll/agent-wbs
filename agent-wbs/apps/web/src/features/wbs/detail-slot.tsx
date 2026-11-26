/**
 * WBS 상세 자리(slot). WBS 화면(WbsPage)은 레일 오른쪽에 `WbsTaskDetail`을 그린다.
 *
 * M3 통합: 이 자리는 M3-03의 `<TaskDetail>`(features/task/TaskDetail.tsx)을 그린다.
 * - 두 화면의 props 모양이 조금 달라서 여기서 바꿔 끼운다(어댑터).
 *   - WBS: `nav.pos`·`nav.prev`·`nav.next`·`nav.back`·`nav.outside`
 *   - Task 상세: `nav.posLabel`·`nav.onPrev`·`nav.onNext`·`nav.backTo`·`nav.onBack`
 * - 탭은 주소 `?tab=`에 둔다(M3-03 규칙). 새로고침·뒤로 가기·공유해도 같은 탭이 열린다.
 * 왜 어댑터인가: 두 기능의 승인된 props를 그대로 두고, 연결 규칙을 한 파일에 모아 두기 위해서다.
 */
import { useLocation, useSearchParams } from 'react-router';
import { isTabKey, TaskDetail, type TabKey } from '../task/TaskDetail.tsx';

export interface WbsDetailNav {
  /** 레일 순서 안의 위치. 예: `7 / 12` */
  pos: string;
  /** 레일의 이전·다음 Task로 이동. 끝이면 null(버튼 비활성) */
  prev: (() => void) | null;
  next: (() => void) | null;
  /** 다른 Task 링크로 왔을 때 「← TASK-xxxx로 돌아가기」. 없으면 null */
  back: { taskKey: string; go: () => void } | null;
  /** 열린 Task가 지금 필터에 맞지 않음 → 「목록 밖」 */
  outside: boolean;
}

export interface WbsTaskDetailProps {
  taskKey: string;
  /** WBS 목록(listTasks)을 읽은 프로젝트. 상세의 선행 Task 제목·의존성 후보에 쓴다. */
  projectId: string;
  nav: WbsDetailNav;
  /**
   * 상세 안의 Task 링크(선행 Task 등)를 열 때 부른다. WBS 화면이 주소를 바꾼다.
   * ref=true(참조 링크)면 「돌아가기」 기록을 남기고, false면 남기지 않는다(M3-03 규칙).
   */
  onOpenTask: (taskKey: string, ref: boolean) => void;
}

/** 「목록 밖」 문구(원본 P L5100) */
const OUTSIDE = '목록 밖 (필터에 맞지 않음)';

export function WbsTaskDetail({ taskKey, projectId, nav, onOpenTask }: WbsTaskDetailProps) {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const tabParam = search.get('tab');
  const tab: TabKey = isTabKey(tabParam) ? tabParam : 'overview';
  return (
    <TaskDetail
      taskKey={taskKey}
      projectId={projectId}
      tab={tab}
      // 탭을 바꿔도 「돌아가기」 기록(history state)은 그대로 둔다.
      onTab={(next) => { setSearch(next === 'overview' ? {} : { tab: next }, { state: location.state as unknown }); }}
      nav={{
        posLabel: nav.outside ? OUTSIDE : nav.pos,
        onPrev: nav.prev ?? undefined,
        onNext: nav.next ?? undefined,
        backTo: nav.back?.taskKey ?? null,
        onBack: nav.back?.go,
      }}
      onOpenTask={onOpenTask}
    />
  );
}
