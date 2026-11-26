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
| `W e2e -- states` | **M3-01 완료 조건.** 로그인·로딩·오류·충돌·잠금·편집 보호·화면 폭 E2E |
| `W e2e` | 모든 E2E(앱 틀 `shell`, 시각 비교 `visual` 포함) |
| `W e2e -- visual` | 원본 스크린샷과 나란히 비교(§5) |
| `W e2e -- project` | **M3-04 완료 조건.** 프로젝트 메뉴 E2E·폭·시각 비교(features/project/README.md) |
| `W e2e -- planning` | **M3-05 완료 조건.** Planning·변경 제안 화면 E2E와 시각 비교(features/planning/README.md) |
| `W --filter @awbs/web e2e:api` | 실제 API·전용 DB로 로그인 E2E(§4) |
| `W e2e -- task-detail` | **M3-03 완료 조건.** Task 상세 9탭(사용법은 [features/task/README.md](src/features/task/README.md)) |
| `W --filter @awbs/web e2e:api:task` | 실제 API·전용 DB(demo seed)로 Task 상세 E2E |
| `W e2e -- exec` | **M3-06 완료 조건.** 작업 실행 화면 E2E·시각 비교([features/exec/README.md](src/features/exec/README.md)) |
| `W --filter @awbs/web e2e:api-exec` | 실제 API·전용 DB(demo seed)로 작업 실행 핵심 흐름 E2E |
| `node apps/web/scripts/prototype-css.ts` | 원본 CSS를 다시 옮긴다(`--check`는 최신인지 확인만) |

- `-- <이름>`은 시험 파일 이름 필터다. 예: `W e2e -- states`는 `states*.spec.ts`만 실행한다.
- 왜 `scripts/playwright.ts`를 거치나: pnpm이 `--`를 그대로 넘기면 Playwright가 필터를 무시하고 전부 실행하기 때문이다.
- 개발 서버에서 저장(변경 요청)까지 하려면 API의 `.env`에 `AWBS_ORIGIN=http://127.0.0.1:5173`을 둔다. 서버가 화면 주소(Origin)를 확인하기 때문이다.

## 2. 폴더 지도

```
src/
  main.tsx                 시작점. Mantine → ApiProvider → FeedbackProvider → Router 순서로 감싼다
  app/
    router.tsx             주소(라우팅) 표. 메뉴 연결은 병합 때 coordinator가 한다(shared/README §1)
    pages.tsx              아직 안 만든 메뉴(PendingPage)·404 화면
    sandbox/               공통 부품 견본(/_states). 개발·E2E 빌드에만 들어간다
  features/
    auth/                  로그인 화면(UI-AUTH)
    task/                  Task 상세 9탭(M3-03). 다른 화면은 <TaskDetail>을 가져다 쓴다
    project/               M3-04 프로젝트 메뉴(등록·초기 분석·입력 변경·초기화). 사용법은 features/project/README.md
    <menu>/                M3-02~08이 만들 메뉴별 화면(예: features/wbs)
    planning/, change/     M3-05 Planning·변경 제안. 사용법·원본과 다른 점은 features/planning/README.md
  shared/                  ★ 모든 화면이 함께 쓰는 것. 사용법은 shared/README.md
    api/                   API 호출 계층·계약 타입·세션·변경 이벤트 polling
    auth/                  로그인 필요 화면 감싸기, 1회용 링크 해석
    layout/                앱 틀(Shell)·메뉴 12개·MenuScreen·Page
    state/                 로딩 규칙·저장 흐름(useSave)·편집 보호(useEditGuard)
    styles/                prototype.css(원본 그대로)·product.css(제품 추가분)·fonts.css
    tokens/                디자인 토큰(TypeScript용)
    ui/                    로딩 5종·오류 막대·충돌 창·확인창·빈 상태·표 스크롤 등
e2e/                       Playwright 시험. support/fake-api.ts가 가짜 API
test/                      단위 시험(Vitest)
scripts/                   원본 CSS 옮기기·Playwright 실행·실제 API E2E 준비
```

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
