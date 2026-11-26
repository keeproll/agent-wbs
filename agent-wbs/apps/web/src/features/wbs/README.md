# features/wbs — WBS 화면(M3-02)

WBS(Work Breakdown Structure, 일을 Phase → Work Package → Task로 나눈 표) 화면이다.
원본 `prototype/uiux/Main.dc.html`의 UI-03(P L791–977)과 Task 생성 Wizard MOD-06(P L2785–2847)을 그대로 옮겼다.

- 처음이라면 [apps/web/README.md](../../../README.md) → [src/shared/README.md](../../shared/README.md) → 이 문서 순서로 읽는다.
- 낯선 말은 맨 아래 [용어집](#용어집)에 있다.

## 1. 한눈에 보기

| 주소 | 보이는 것 |
|---|---|
| `/wbs` | 전체 폭의 표(또는 Gantt) |
| `/wbs/TASK-0007` | 왼쪽 260px 레일(Task 목록) + 오른쪽 Task 상세 |
| `/wbs/TASK-0007?tab=spec` | 위와 같고, 상세가 「작업 명세」 탭을 연다(탭은 M3-03) |
| `/wbs/TASK-9999`(없는 Task) | 표 + 위쪽 빨간 안내 「404 TASK_NOT_FOUND」와 「닫기」 |

- 왜 한 화면이 두 주소를 받나: 표 ↔ 상세를 오갈 때 필터·정렬·스크롤을 잃지 않게 하려고다(G§4.3 「목록 ↔ 상세 전환」).
- 키보드: 상세가 열려 있으면 ↑/↓ 또는 K/J로 이전·다음 Task, Esc로 「펼치기」(표로 돌아가기).
  - 입력 칸에 글자를 쓰는 중이거나 창(모달)이 열려 있으면 동작하지 않는다. 왜: 글자 입력과 겹치면 안 되기 때문이다.

## 2. 파일 지도

| 파일 | 하는 일 |
|---|---|
| `WbsPage.tsx` | 화면 전체. 데이터 읽기, 필터·정렬·접힘 상태, 표 ↔ 레일 전환, 키보드, Wizard 열기 |
| `model.ts` | 화면 없는 계산. 필터 9·WP 안 정렬·그룹 집계·레일 순서·셀 문구·Gantt 좌표·Wizard 검증. 단위 시험 `test/wbs-model.test.ts` |
| `WbsToolbar.tsx` | 도구 막대(검색 + 선택 필터 8 + 초기화, 보기·정렬·모두 펼치기/접기·컬럼) |
| `WbsTable.tsx` | Tree Table + 가상 스크롤 |
| `WbsGantt.tsx` | Gantt + 가상 스크롤 |
| `TaskRail.tsx` | 260px 레일 |
| `detail-slot.tsx` | 상세 자리(slot). M3-03 연결 지점(§5) |
| `TaskDetailPane.tsx` | M3-02의 임시 상세(머리·요약만). M3-03 연결 뒤에는 쓰지 않는다 |
| `TaskWizard.tsx` | Task 생성 3단계 Wizard |
| `cells.tsx` | 상태 표시·아이콘 같은 작은 조각 |
| `wbs.css` | WBS 화면에만 필요한 추가 CSS(이유를 규칙마다 적음) |

## 3. 데이터 — 어떤 API를 언제 부르나

| 요청 | 언제 | 변경 이벤트 topic |
|---|---|---|
| `listTasks`(`GET /api/projects/:projectId/tasks`) | 화면을 열 때, 검색어·상태 필터가 바뀔 때 | task·dependency·schedule |
| `getSchedule`(`GET /api/schedule`) | 화면을 열 때 | schedule·task·dependency·settings |
| `getRunnerState` | 일정 요약의 「동시 실행 한도」 | runner |
| `getTask`(`GET /api/tasks/:taskKey`) | 상세를 열 때. 없으면 404 안내 | task·dependency·attempt·verification |
| `createTask` → `getTask` → `addDependency`(선행마다) | Wizard 「Task 생성」 | — |

필터를 어디서 거르나:

- **검색어와 상태 필터 한 가지는 서버로 보낸다**(계약의 `q`·`status`).
  - 검색어는 0.25초 동안 입력이 멈추면 보낸다. 왜: 글자마다 요청하지 않으려고.
  - 새 응답이 올 때까지 이전 목록과 상단 진행 막대를 보인다(UAT-STATE-02-UI). 그래서 이 두 조건은 화면에서 다시 거르지 않는다.
- **나머지 필터는 화면에서 거른다**(작업 유형·기술 영역·담당·우선순위·Phase·선행 차단·검증 상태, 그리고 상태의 「진행 중」 묶음).
  - 왜: 계약에 그 조건이 없고, 목록 응답에 판단할 값이 모두 들어 있다.
- 필터 결과에는 매칭 Task의 상위 Phase·Work Package가 항상 함께 보인다(G§4.3).
- 정렬은 Work Package 안에서만 적용한다. Phase·WP 순서는 WBS 번호 그대로다.

## 4. 가상 스크롤(화면에 보이는 행만 그리기)

- 표와 Gantt는 `@tanstack/react-virtual` 3.13.2로 보이는 행과 위아래 8행만 그린다.
- 보이지 않는 행 높이는 위·아래 padding으로 대신한다. 그래서 행마다 격자(grid) 배치와 원본 CSS가 그대로다.
- 행 높이는 실제로 잰다(글자가 두 줄이 되는 행도 정확). 처음 예상값은 그룹 43px·Task 75px(Gantt 40·53px)이다.
- 상세가 열려 표가 숨겨진 동안에는 행 높이를 0으로 재지 않고 이전 값을 쓴다.
  - 왜: 0으로 재면 「펼치기」로 돌아왔을 때 보던 위치에서 수십 행 벗어난다(시험으로 확인한 결함).
- 측정 기록(UAT-WBS-05): `~/.orca/bots/agentwbs/archive/2026-11-26/M3-02/perf/`
  - `wbs-perf.md` — 가짜 API, 200·1,000행. `W e2e -- wbs-perf`.
  - `wbs-perf-api.md` — 실제 API·전용 DB, 200·1,000행. `W --filter @awbs/web e2e:api-wbs`.
  - 화면 쪽은 1,000행에서도 그리는 행이 19~20개라 빠르다(첫 행 약 0.3초, 가짜 API).
  - 서버 쪽은 1,000행에서 `listTasks`·`getSchedule`이 각각 7~9초 걸린다(2026-11-27 측정). 화면은 둘을 함께 부르므로 10초 제한을 넘겨 「불러오기 실패」가 된다. 서버 결함으로 보고했다.

## 5. M3-03(Task 상세)과 연결하는 방법

상세 영역은 `detail-slot.tsx` 한 파일로만 연결된다.

1. M3-03의 `features/task/TaskDetail.tsx`가 아래 props를 받는다.
   - `taskKey`: 열 Task ID.
   - `nav.pos`: 레일 순서 안의 위치(예: `7 / 12`).
   - `nav.prev`·`nav.next`: 이전·다음 Task로 가는 함수. 끝이면 `null`(버튼 비활성).
   - `nav.back`: 다른 Task 링크로 왔으면 `{ taskKey, go }`(「← TASK-xxxx로 돌아가기」), 아니면 `null`.
   - `nav.outside`: 열린 Task가 지금 필터에 맞지 않으면 `true`(「목록 밖 (필터에 맞지 않음)」).
   - `onOpenTask(taskKey)`: 상세 안의 Task 링크를 열 때 부른다. WBS 화면이 주소를 바꾸고 「돌아가기」 기록을 남긴다.
2. 병합 때 `detail-slot.tsx`의 마지막 줄을 아래로 바꾼다.
   ```ts
   export { TaskDetail as WbsTaskDetail } from '../task/TaskDetail.tsx';
   ```
3. 라우터: WBS 메뉴 줄이 `/wbs`와 자식 `:taskKey`를 모두 `WbsPage`로 받는다(`src/app/router.tsx`).
   - 따로 있는 `{ path: '/wbs/:taskKey', element: <PendingPage …/> }` 줄은 M3-02가 건드리지 않았다(coordinator 지시).
   - WBS 메뉴 줄의 자식 경로가 먼저 맞으므로 그 줄은 쓰이지 않는다. 병합 때 지우거나 `WbsPage`로 바꾼다.
- 상세 데이터는 `useApiQuery('getTask', { params: { taskKey } })`로 읽는다. WBS 화면도 같은 query key로 읽으므로 요청은 한 번이다.

## 6. Task 생성 Wizard

- 3단계: ① 기본 정보·분류 → ② 목적·범위·완료 조건 → ③ 선행 Task·확인.
- 단계마다 필수값을 검사하고 「다음」을 막는다(UAT-WIZ-01).
  - 시간은 0보다 크고 400 이하의 숫자, 고정 시작일은 `YYYY-MM-DD`.
  - 이전 단계로 돌아가도 입력은 그대로다.
- 상위 Work Package는 서버가 준 실제 목록만 고를 수 있다(MM-05).
  - 그 사이 지워진 WP로 보내면 서버가 `404 WBS_NODE_NOT_FOUND`로 거부한다. 화면은 오류 막대를 띄우고 목록을 다시 읽는다(UAT-WIZ-02).
- 제목이나 목적을 쓴 뒤 닫으면(×·취소·Esc) 「Task 생성 취소」를 묻는다(UAT-WIZ-04).
  - 확인창의 「취소」는 입력을 그대로 둔다. 「생성 취소」만 초안을 버린다.
- 생성은 두 단계이고, 단계마다 `useSave`를 하나씩 쓴다.
  1. **Task 만들기**(`createTask`): 누른 순간의 입력을 `request()`로 찍어 둔다. 결과를 모를 때 「다시 시도」는 같은 내용·같은 멱등 키(Idempotency-Key, 같은 요청을 두 번 처리하지 않게 하는 번호)로 보낸다.
  2. **선행 연결**(`addDependency`, 선행마다 FS = Finish-to-Start, 선행이 끝나야 시작): 만든 Task를 기억해 두고 이 단계만 다시 한다.
  - 왜 나누나: 선행 연결이 실패했을 때 「Task 생성」을 다시 누르면 새 키로 Task가 또 만들어졌다(독립 리뷰 #1, 실제 DB에서 중복 확인).
  - 선행 연결이 실패하면 창에 「TASK-xxxx을(를) 이미 만들었습니다」를 보이고, 버튼이 「선행 연결」·「선행 없이 마치기」로 바뀐다. 「이전」은 막는다.
  - 지워진 선행 때문에 실패하면(404) 목록을 다시 읽는다. 사용자는 그 선행을 빼고 다시 연결한다.
  - 충돌(409 `VERSION_CONFLICT`)은 공통 충돌 창으로 묻는다. 「다시 적용」은 서버의 최신 버전을 다시 읽어 선행을 붙이고 마친다. 「최신 불러오기」는 붙이지 않고 최신 상태만 다시 읽으며, 선택은 그대로 둔다.
  - 만든 뒤에 창을 닫으면(×·Esc) 버릴 초안이 없으므로 묻지 않고 「선행 없이 마치기」와 같이 그 Task로 간다.
- 편집 보호: 제목이나 목적을 쓴 동안 뒤로 가기·메뉴 이동은 공통 확인창(「편집 내용 버리기」), 새로고침·창 닫기는 브라우저 확인을 띄운다(`useEditGuard`). Task를 만든 뒤에는 풀린다.
- 세션이 끊기면(401) 초안을 이 탭에 보관하고 다시 로그인하면 복원을 제안한다(`useSessionDraft`).
- 선행 선택지는 표의 검색·상태 필터와 상관없이 프로젝트의 모든 Task다(필터가 없을 때와 같은 query).
- 생성이 끝나면 `/wbs/<새 ID>?tab=spec`으로 이동하고 「…을(를) 생성했습니다. 작업 명세를 작성하세요.」를 안내한다.
- **아직 서버에 보내지 못하는 값**: 예상 소요 시간·고정 시작일.
  - 계약의 `createTask` 본문에 그 필드가 없다(보고함). 그래서 화면은 검사만 하고, 3단계에 「저장되지 않습니다」를 밝힌다.
  - 왜 밝히나: 「실제로 구현하지 않은 동작은 완료된 기능처럼 표현하지 않는다」(G§9.7-3).

## 7. 시험

| 명령 | 내용 |
|---|---|
| `W test` | `test/wbs-model.test.ts` — 필터·정렬·집계·레일·Gantt 좌표·Wizard 검증 |
| `W e2e -- wbs` | WBS E2E 전부(아래 파일들). 주의: 경로에 `agent-wbs`가 들어 있어 이 필터는 사실상 모든 E2E를 실행한다 |
| `W e2e -- wbs-table` | UAT-WBS-01·02, UAT-EMPTY-10, UAT-STATE-02-UI, 행 문구 |
| `W e2e -- wbs-rail` | 시나리오 27, 스크롤 유지, UAT-WBS-05(없는 Task) |
| `W e2e -- wbs-wizard` | 시나리오 1(생성 부분), UAT-WIZ-01·02·04, 세션 만료 초안 |
| `W e2e -- wbs-recovery` | 독립 리뷰 지적의 실패 경로: 중복 생성 없음, 뒤로 가기·새로고침 보호, 충돌 복구, 상세 503, 필터와 무관한 선행 선택지, 390px 도구 막대, 제목 순서 |
| `W e2e -- wbs-responsive` | D-28: 1280·1920 가로 스크롤 없음, 1100·1024·768은 표 상자만 가로 스크롤 |
| `W e2e -- wbs-perf` | 200·1,000행 측정(가짜 API) |
| `W e2e -- wbs-visual` | 원본 스크린샷 비교(§8) |
| `W --filter @awbs/web e2e:api-wbs` | 실제 API·전용 DB(demo seed). 12건 표·UAT-WIZ-02 서버 거부·Wizard 실제 생성·200/1,000행 응답 측정 |

- 가짜 API 도우미: `e2e/support/wbs-api.ts`(목록을 서버처럼 거르고 생성·선행 추가를 메모리에 반영), 자료: `e2e/support/wbs-fixture.ts`.
- 시험 자료는 원본 기본 Mock(Task 12건)과 같은 구성이다. 그래서 원본 스크린샷과 나란히 비교할 수 있다.

## 8. 시각 비교(wbs-visual)

- 조건: viewport 1920×1080(표는 1280×800도), 기기 배율 1, ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST, 애니메이션 끔.
- 차이 계산: M3-01과 같다(pixelmatch, threshold 0.1, 안티에일리어싱 픽셀 제외).
- 결과: `~/.orca/bots/agentwbs/archive/2026-11-26/M3-02/visual/`에 `[원본 | 구현 | 차이]` 이미지와 `summary.md`.
- 합격 기준(넘으면 시험 실패)
  - 같아야 하는 영역은 차이 2~3% 이하: 제목·일정 요약, 도구 막대, 표 머리·그룹 행, Gantt 날짜 눈금·범례, 레일, 상세 머리, Wizard 1단계.
  - 왜 2~3%까지 허용하나: 글꼴 번짐과 원본 캡처의 미세한 위치 차이(1px)가 쌓이기 때문이다.
- 예외(기록만 하고 실패시키지 않음)
  - 표 본문: 「예상 실행」의 토큰 수(`· 180K`)가 없다. 계약의 일정 요약에 토큰 추정치가 없기 때문이다.
  - 표 본문: 원본은 「충족 1 건」처럼 숫자 뒤에 공백이 보인다. 원본 템플릿 바인딩이 만든 공백이라 제품은 「충족 1건」이다.
  - 시험 자료의 진행률(Phase 2 등)이 원본 Mock 계산과 몇 % 다르다.
  - 상세 요약: 체크리스트 「필수 n건 남음」, Gate 「▾」 펼침, 선행 문구는 상세 데이터(M3-03)가 필요하다.
  - 1280 원본(`w1280/`)은 시계가 달라(11-26) 일정 날짜 글자가 다르다.

## 9. 원본과 다르게 한 것(이유)

| 무엇 | 원본 | 제품 | 이유 |
|---|---|---|---|
| 표 가로 스크롤 | `overflow-x:hidden`(잘림) | 1280 미만에서 표 상자 안 가로 스크롤 | D-28, MM-29 |
| Phase 필터 목록 | 고정 3개 | 서버 노드에서 만듦 | 실제 데이터와 맞춤 |
| Wizard WP 목록 | 고정 6개(없는 WP-06 포함) | 서버 목록만 | MM-05 |
| Wizard Task ID 미리보기 | `TASK-0013 (자동 부여)` | 「생성 시 자동 부여」 | 번호는 서버가 잠금 안에서 정한다(미리 알 수 없음) |
| Wizard 기본 WP | `WP-03` 고정 | 선택한 Task의 WP, 없으면 첫 WP | 고정 ID는 실제 데이터에 없을 수 있다 |
| 상세 주소·키보드 | 버튼만 | `/wbs/TASK-xxxx`, ↑↓·J/K·Esc | G§4.3 「실제 구현」 |
| 404 안내 닫기 | 상태만 닫음 | `/wbs`로 주소 이동 | 새로고침해도 안내가 다시 뜨지 않게 |
| 컬럼 메뉴 | 버튼으로만 닫힘 | 바깥 클릭·Esc로도 닫힘 | 키보드 사용 |
| 좁은 폭 도구 막대 | 오른쪽 묶음이 한 줄이라 문서가 넘침 | 760px 이하에서 줄바꿈 | MM-29 |
| Wizard 3단계 소제목 | h4 | h3(모양은 원본 h4) | 제목 순서 접근성 |

## 용어집

| 용어 | 뜻 |
|---|---|
| WBS | Work Breakdown Structure. 일을 Phase → Work Package → Task로 나눈 계층 |
| Phase / Work Package(WP) | WBS의 큰 단계 / 그 안의 작업 묶음 |
| 레일(rail) | 상세를 열면 왼쪽에 남는 260px 폭의 좁은 Task 목록 |
| Gantt | 막대로 일정을 보여 주는 차트 |
| Wizard | 여러 단계로 나눠 입력하는 창 |
| 가상 스크롤 | 화면에 보이는 행만 그려 긴 목록을 빠르게 보여 주는 기법 |
| slot(자리) | 다른 작업이 만든 부품을 끼워 넣도록 비워 둔 자리 |
| FS | Finish-to-Start. 선행 Task가 끝나야 후속 Task를 시작할 수 있는 관계 |
| 멱등 키(Idempotency-Key) | 같은 요청이 두 번 와도 한 번만 처리하게 하는 요청 번호 |
| topic | 변경 이벤트 종류. 그 종류가 바뀌면 관련 데이터를 다시 읽는다 |
| debounce | 입력이 잠시 멈출 때까지 기다렸다가 한 번만 처리하는 것 |
