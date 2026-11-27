/**
 * 화면 사이를 오가는 주소 — **한 곳에서만 만든다**(M3 통합).
 *
 * 왜 한 곳에: 화면마다 주소를 따로 만들면 받는 화면과 모양이 어긋난다.
 * 예: 대시보드는 `/exec?task=…`로 보냈는데 작업 실행 화면은 `/exec/:taskKey`만 읽어 엉뚱한 Task가 열렸다.
 * 주소를 받는 규칙(router)은 src/app/router.tsx, 각 화면의 쿼리 이름은 그 화면 파일 머리말에 있다.
 *
 * | 주소 | 여는 화면 | 받는 쪽 |
 * |---|---|---|
 * | `/wbs/TASK-0007?tab=spec` | WBS 레일 + Task 상세(탭) | WbsPage(useMatch) + detail-slot(`?tab=`) |
 * | `/wbs?status=done&view=gantt` | WBS 표(필터·보기) | WbsPage가 처음 그릴 때 읽는다 |
 * | `/exec/TASK-0007?att=<시도 키 또는 id>` | 작업 실행에서 그 Task·시도 | ExecPage(useParams·`?att=`) |
 * | `/verify?sel=<검증 id>` | 검증 결과 상세 | VerifyPage |
 * | `/change/CP-007` | 변경 제안 상세(CP 키 또는 id) | ChangePage(useParams) |
 * | `/planning?session=<id>` | Planning 세션 | PlanningPage |
 * | `/settings/runner` | 설정 탭 | SettingsPage(useParams) |
 * | `/ci/<실행 id>` | 빌드·통합 실행 상세(서버 알림 path와 같은 모양) | CiPage(useParams) |
 */
const enc = encodeURIComponent;

/** WBS 표 주소에 실을 수 있는 조건. 이름은 WBS 화면의 필터 이름(features/wbs/model.ts Filters)과 같다. */
export interface WbsLinkFilter { type?: string; domain?: string; status?: string; agent?: string; priority?: string; phase?: string; blocked?: string; verif?: string; view?: 'table' | 'gantt' }

export const LINK = {
  /** Task 상세(탭: overview·spec·deps·tech·checklist·exec·verif·hist·msg — M3-03) */
  task: (taskKey: string, tab?: string) => `/wbs/${enc(taskKey)}${tab ? `?tab=${enc(tab)}` : ''}`,
  wbs: (filter: WbsLinkFilter = {}) => {
    const search = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')).toString();
    return `/wbs${search ? `?${search}` : ''}`;
  },
  /** 작업 실행. attempt는 시도 키(attemptKey) 또는 시도 id — 작업 실행 화면이 둘 다 찾는다. */
  exec: (taskKey: string, attempt?: string | null) => `/exec/${enc(taskKey)}${attempt ? `?att=${enc(attempt)}` : ''}`,
  verification: (id: string) => `/verify?sel=${enc(id)}`,
  /** 변경 제안. ref는 CP 키(CP-007) 또는 id */
  change: (ref: string) => `/change/${enc(ref)}`,
  /** Planning 세션 */
  planning: (sessionId: string) => `/planning?session=${enc(sessionId)}`,
  /** 빌드·통합 실행 상세(M7-05). 서버 알림·통지 ref의 `path: /ci/<id>`와 같다. */
  ci: (runId: string) => `/ci/${enc(runId)}`,
  settings: (tab?: string) => (tab ? `/settings/${enc(tab)}` : '/settings'),
};
