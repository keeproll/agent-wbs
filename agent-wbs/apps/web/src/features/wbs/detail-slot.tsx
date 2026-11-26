/**
 * WBS 상세 자리(slot). WBS 화면(WbsPage)은 레일 오른쪽에 `WbsTaskDetail`을 그린다.
 *
 * 병합 때 할 일(M3-03 TaskDetail 연결): 이 파일의 마지막 export 한 줄을 아래로 바꾼다.
 *   export { TaskDetail as WbsTaskDetail } from '../task/TaskDetail.tsx';
 * 그러면 WbsPage가 「레일 + M3-03 상세」를 조합한다. props 모양은 M3-03과 맞춘 아래 타입이다.
 */
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
  nav: WbsDetailNav;
  /** 상세 안의 Task 링크(선행 Task 등)를 열 때 부른다. WBS 화면이 주소를 바꾸고 돌아가기 기록을 남긴다. */
  onOpenTask: (taskKey: string) => void;
}

export { TaskDetailPane as WbsTaskDetail } from './TaskDetailPane.tsx';
