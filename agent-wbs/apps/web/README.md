# apps/web — Agent WBS 화면(웹)

팀장이 브라우저로 쓰는 화면이다.
M3-01이 모든 메뉴 화면이 함께 쓰는 바탕(앱 틀·로그인·공통 상태·디자인 토큰·API 호출 계층)을 만들었다.
M3-02~08은 이 바탕 위에 각 메뉴의 본문을 얹는다.

- 처음이라면 이 문서 → [src/shared/README.md](src/shared/README.md)(공통 부품 사용법) 순서로 읽는다.
- 낯선 말은 맨 아래 [용어집](#용어집)에 있다.

## 1. 명령

저장소 루트(`agent-wbs`의 부모 폴더)에서 실행한다. `W`는 `pnpm -C agent-wbs`의 줄임이다(docs/plan/milestones.md §1).

| 명령 | 하는 일 |
|---|---|
| `W dev` | 개발 서버. 화면 `127.0.0.1:5173`, API `127.0.0.1:3100` |
| `W check` | typecheck + lint + 단위 시험 |
| `W build` | 전체 빌드 |
| `W e2e` | 모든 E2E(가짜 API). 실제 API 시험(`api-*.spec.ts`)은 아래 `e2e:api*` 명령으로만 돈다 |
| `W e2e -- nav-integration` | **M3 통합.** 화면 사이 이동·알림 링크 주소·390px 상세 열람·메뉴 12개 폭(§2-1) |
| `W e2e -- visual` | 원본 스크린샷과 나란히 비교(§5). 화면별 비교는 각 기능 README |
| `node apps/web/scripts/prototype-css.ts` | 원본 CSS를 다시 옮긴다(`--check`는 최신인지 확인만) |

마일스톤별 완료 조건 시험이다. 자세한 내용은 각 기능 README에 있다.

| 마일스톤 | 가짜 API E2E | 실제 API·전용 DB E2E |
|---|---|---|
| M3-01 앱 틀·공통 상태 | `W e2e -- states` | `W --filter @awbs/web e2e:api` |
| M3-02 WBS | `W e2e -- wbs-` ([features/wbs/README.md](src/features/wbs/README.md) §7) | `W --filter @awbs/web e2e:api-wbs` |
| M3-03 Task 상세 | `W e2e -- task-detail` ([features/task/README.md](src/features/task/README.md)) | `W --filter @awbs/web e2e:api:task` |
| M3-04 프로젝트 | `W e2e -- project` ([features/project/README.md](src/features/project/README.md)) | — |
| M3-05 Planning·변경 제안 | `W e2e -- planning` ([features/planning/README.md](src/features/planning/README.md)) | — |
| M3-06 작업 실행 | `W e2e -- exec` ([features/exec/README.md](src/features/exec/README.md)) | `W --filter @awbs/web e2e:api-exec` |
| M3-07 대시보드·검증·이력 | `W e2e -- verify history dashboard` ([features/verify/README.md](src/features/verify/README.md)) | `W --filter @awbs/web e2e:api:m307` |
| M3-08 설정 | `W e2e -- settings-core` ([features/settings/README.md](src/features/settings/README.md)) | `W --filter @awbs/web e2e:api-settings` |

- `-- <이름>`은 시험 파일 이름 필터다. 예: `W e2e -- states`는 `states*.spec.ts`만 실행한다.
- 왜 `scripts/playwright.ts`를 거치나: pnpm이 `--`를 그대로 넘기면 Playwright가 필터를 무시하고 전부 실행하기 때문이다.
- 개발 서버에서 저장(변경 요청)까지 하려면 API의 `.env`에 `AWBS_ORIGIN=http://127.0.0.1:5173`을 둔다. 서버가 화면 주소(Origin)를 확인하기 때문이다.

## 2. 폴더 지도

```
src/
  main.tsx                 시작점. Mantine → ApiProvider → FeedbackProvider → Router 순서로 감싼다
  app/
    router.tsx             주소(라우팅) 표. 메뉴 화면 표(SCREENS)와 하위 주소 표(DETAIL)가 있다(§2-1)
    pages.tsx              아직 안 만든 메뉴(PendingPage)·404 화면
    sandbox/               공통 부품 견본(/_states). 개발·E2E 빌드에만 들어간다
  features/
    auth/                  로그인 화면(UI-AUTH, M3-01)
    dashboard/             대시보드(M3-07)
    project/               프로젝트 — 등록·초기 분석·입력 변경·정보 편집·초기화(M3-04)
    wbs/                   WBS 표·Gantt·레일·Task 생성 Wizard(M3-02). 상세 자리는 task/의 <TaskDetail>
    task/                  Task 상세 9탭(M3-03). WBS 화면이 레일 옆에 놓는다
    planning/, change/     Planning·변경 제안(M3-05)
    exec/                  작업 실행(M3-06)
    verify/, history/      검증·이력(M3-07)
    settings/              설정 6탭(M3-08)
  shared/                  ★ 모든 화면이 함께 쓰는 것. 사용법은 shared/README.md
    api/                   API 호출 계층·계약 타입·세션·변경 이벤트 polling
    auth/                  로그인 필요 화면 감싸기, 1회용 링크 해석
    layout/                앱 틀(Shell)·메뉴 12개·MenuScreen·Page
    state/                 로딩 규칙·저장 흐름(useSave)·편집 보호(useEditGuard)
    styles/                prototype.css(원본 그대로)·product.css(제품 추가분)·fonts.css
    tokens/                디자인 토큰(TypeScript용)
    ui/                    로딩 5종·오류 막대·충돌 창·확인창·빈 상태·표 스크롤 등
    links.ts               ★ 화면 사이 주소를 만드는 단 한 곳(§2-1)
e2e/                       Playwright 시험. support/fake-api.ts가 가짜 API
test/                      단위 시험(Vitest)
scripts/                   원본 CSS 옮기기·Playwright 실행·실제 API E2E 준비
```

### 2-1. 주소와 화면 사이 이동(M3 통합)

메뉴 12개의 주소는 `/<메뉴 key>`다(예: `/wbs`, `/settings`). 알림·보고서·다른 화면이 여는 상세 주소는 아래 네 가지다.

| 주소 | 여는 화면 | 예 |
|---|---|---|
| `/wbs/:taskKey` | WBS 레일 + Task 상세. `?tab=`으로 탭을 고른다 | `/wbs/TASK-0007?tab=verif` |
| `/exec/:taskKey` | 작업 실행에서 그 Task. `?att=`로 시도를 고른다(시도 키 또는 id) | `/exec/TASK-0007?att=ATT-0007-2` |
| `/change/:cpRef` | 변경 제안 상세. CP 키 또는 id | `/change/CP-002` |
| `/settings/:tab` | 설정의 그 탭 | `/settings/runner` |

- 목록 화면의 조건도 주소에 싣는다. 예: `/wbs?status=done`(완료만), `/wbs?blocked=y`(선행 차단만), `/wbs?view=gantt`, `/planning?session=<id>`, `/verify?sel=<검증 id>`.
- **주소는 `src/shared/links.ts`의 `LINK`로만 만든다.**
  - 왜: 화면마다 주소를 손으로 쓰면 받는 화면과 어긋난다. 통합 전에는 대시보드가 `/exec?task=…`로 보냈는데 작업 실행 화면은 `/exec/:taskKey`만 읽어 엉뚱한 Task가 열렸다.
  - 예: `LINK.exec('TASK-0007', attempt.id)` → `/exec/TASK-0007?att=<id>`.
- 받는 규칙은 `src/app/router.tsx` 한 곳에 있다. 상세 주소는 메뉴 주소와 **같은 화면·같은 key**로 그린다.
  - 왜: 목록에서 상세로 옮겨도 화면을 새로 만들지 않아 필터·스크롤·편집 상태가 남는다.
- 화면 사이 이동은 `e2e/nav-integration.spec.ts`가 확인한다(원본 inventory 「정상 메뉴 이동의 연결」).

## 3. 디자인 기준 — 원본과 같게

- 원본(`prototype/uiux/Main.dc.html`)의 `<style>` 전체를 `src/shared/styles/prototype.css`로 **한 글자도 바꾸지 않고** 옮겼다.
  - 왜: 손으로 옮기면 값이 바뀌거나 빠진다. 스크립트가 옮기고, 단위 시험(`test/tokens.test.ts`)이 원본과 같은지 매번 확인한다.
  - 원본 줄 번호(`/* L123 */`)를 각 줄에 남겼다. docs/ui/design-tokens.md 부록과 같은 표기다.
- 그래서 화면은 원본과 **같은 클래스 이름**(`.btn`, `.card`, `.page-h`, `.tbl` 등)을 쓴다. 새 CSS를 만들기 전에 원본에 같은 모양이 있는지 먼저 찾는다.
- 원본에 없거나 원본과 다르게 해야 하는 규칙만 `product.css`에 적는다. 규칙마다 이유를 적는다.
  - 예: 움직임 줄이기에서 원본은 스피너를 느리게만 하지만 제품은 멈춘다(MM-17).
- TypeScript에서 색·크기 값이 꼭 필요하면 `src/shared/tokens/tokens.ts`를 쓴다(예: SVG 차트 색).
- 글꼴은 npm 패키지 `pretendard-gov` 1.3.9를 번들한다(원본의 jsDelivr 외부 주소는 쓰지 않음).

## 4. 실제 API로 로그인 시험(e2e:api)

`W --filter @awbs/web e2e:api`가 아래를 모두 하고 끝나면 지운다.

1. 이 시험 전용 PostgreSQL 컨테이너(`m301-e2e-pg-…`)를 빈 포트에 띄운다. 개발용 `awbs-postgres`는 건드리지 않는다.
2. migration → `seed system` → auth CLI로 LAN 비밀번호 설정 → API를 LAN 모드로 기동 → auth CLI로 1회용 링크 발급.
   - LAN 모드는 `127.0.0.1`이 아닌 주소에서만 켜지므로 API를 `127.0.0.2`(같은 PC의 다른 loopback 주소)에 띄운다.
3. `e2e/api-auth.spec.ts`(UAT-AUTH-01~03)를 실행한다. 이 파일은 환경 변수가 없으면 건너뛴다.

- 주의: `seed system` 없이 migration만 한 DB에서는 `GET /api/runner-state`가 500을 돌려준다. 개발 DB를 새로 만들 때도 `pnpm --filter @awbs/db seed:system`을 실행한다.

## 5. 시각 비교(visual)

`e2e/visual.spec.ts`가 원본 스크린샷(`~/.cache/agent-wbs-baseline/`)과 같은 조건으로 구현 화면을 찍어 같은 영역을 비교한다.

- **조건**: viewport 1920×1080(앱 틀은 1280×800도), 기기 배율 1, ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST, 애니메이션 끔, 마우스는 화면 구석.
- **차이 계산**: pixelmatch, 색 차이 기준 `threshold 0.1`, 안티에일리어싱(글자 가장자리 번짐) 픽셀은 세지 않는다.
- **결과**: `~/.orca/bots/agentwbs/archive/2026-11-26/M3-01/visual/`에 `[원본 | 구현 | 차이]` 이미지와 `summary.md`.
- **합격 기준**
  - 같아야 하는 영역(메뉴·헤더 왼쪽·접힌 메뉴·skeleton·공용 확인창)은 차이 1~2% 이하. 넘으면 시험이 실패한다.
  - 2%까지 허용하는 이유: 원본 skeleton은 반짝임 애니메이션 도중 찍혀 회색 농도가 조금 다를 수 있다.
- **예외(기록만 하고 실패시키지 않음)**: 제품 결정으로 글자가 달라진 영역이다.
  - 헤더 오른쪽: 「Prototype · Mock 데이터」·MOCK 표시 없음, 로그아웃 버튼 추가.
  - 불러오기 실패 카드: 원본 「503 SERVICE_UNAVAILABLE · 10초 초과」 대신 계약 코드 「503 UNAVAILABLE」.
  - 오류 막대: 원본 「500 INTERNAL_ERROR」 대신 계약 코드 「500 INTERNAL」.
  - 충돌 창: 원본은 마지막 이력 한 줄, 제품은 서버가 준 같은 대상의 변경 목록(MM-20). 폭 620px은 검사한다.
  - 안내(toast): 문구 길이가 달라 폭이 다르다. 오른쪽·아래 24px 위치는 검사한다.
- 휴대폰(390px) 원본 사진은 viewport meta가 없어 980px로 그려진 것이라 비교하지 않는다(design-tokens.md 「좁은 폭」).

## 용어집

| 용어 | 뜻 |
|---|---|
| E2E | End-to-End. 실제 브라우저로 화면을 열고 끝까지 눌러 보는 시험 |
| 가짜 API(fake API) | Playwright가 `/api` 요청을 가로채 정해 둔 응답을 주는 것. 서버 없이 오류·지연을 마음대로 만든다 |
| skeleton | 데이터가 오기 전 화면 배치 모양만 회색으로 먼저 보이는 로딩 표시 |
| viewport | 브라우저에서 실제로 보이는 화면 영역 |
| viewport meta | 휴대폰이 화면 폭을 실제 기기 폭으로 계산하게 하는 HTML 설정 |
| Origin | 브라우저 주소의 출처(프로토콜·호스트·포트). 서버가 다른 사이트의 변경 요청을 막는 데 쓴다 |
| loopback | 같은 PC 안에서 자기 자신에게 접속하는 주소(127.x.x.x) |
| LAN | 같은 사무실 네트워크 |
| pixelmatch | 두 그림의 픽셀을 비교해 다른 픽셀 수를 세는 도구 |
| 디자인 토큰 | 색·간격·크기 같은 디자인 값에 이름을 붙여 한곳에서 관리하는 방식 |
| 하위 주소(상세 주소) | 메뉴 주소 아래에 붙는 주소. 예: `/wbs/TASK-0007`. 알림 링크가 이 주소로 상세를 연다 |
| key(React) | 화면 조각의 이름표. 같은 이름표면 화면을 새로 만들지 않고 상태를 유지한다 |
| 어댑터 | 모양이 다른 두 부품을 이어 주는 작은 변환 코드(예: WBS 상세 자리 `detail-slot.tsx`) |
