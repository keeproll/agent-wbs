# M3-07 — 대시보드 · 검증 · 이력 화면

이 문서는 M3-07에서 만든 세 화면의 사용 설명이다.
세 화면은 대시보드(UI-01), 검증(UI-07), 이력(UI-10)이다.
원본 `prototype/uiux/Main.dc.html`의 P L1858–1991을 그대로 옮겼다.

- 처음이라면 [apps/web/README.md](../../../README.md) → [src/shared/README.md](../../shared/README.md) → 이 문서 순서로 읽는다.
- 낯선 말은 맨 아래 [용어집](#용어집)에 있다.

## 1. 한눈에 보기

| 주소 | 보이는 것 |
|---|---|
| `/dashboard` | 대시보드 |
| `/verify` | 검증 결과 목록 |
| `/verify?sel=<검증 id>` | 왼쪽 레일(목록) + 오른쪽 검증 상세 |
| `/verify?tab=evidence` | Evidence 목록 |
| `/verify?tab=gate` | Completion Gate 미통과 Task. `&gate=all`이면 전체 |
| `/verify?result=FAIL&agent=Codex` | 판정·Agent 필터를 건 목록 |
| `/history?from=2026-11-01&to=2026-11-02&kind=실행` | 기간·유형 필터를 건 이력 |

- 탭·선택·필터를 모두 주소에 둔다.
  - 왜: 새로고침·뒤로 가기·알림 링크로 같은 화면이 열려야 한다(MM-29).
- 키보드(UAT-TASK-11):
  - 검증 목록에서 ↑/↓로 행을 옮기고 Enter로 연다.
  - 검증 상세에서 ↑/K는 이전, ↓/J는 다음, Esc는 「펼치기」(목록으로)다.
  - 글자를 입력하는 중이거나 창(모달)이 열려 있으면 동작하지 않는다. 왜: 입력 중인 글자와 겹치면 안 된다.

## 2. 파일 지도

| 파일 | 하는 일 |
|---|---|
| `dashboard/DashboardPage.tsx` | 대시보드 화면 |
| `dashboard/model.ts` | 대시보드의 글자·색·이동 주소 계산. 단위 시험 `test/dashboard-model.test.ts` |
| `verify/VerifyPage.tsx` | 검증 화면(탭 3개·레일·상세·키보드) |
| `verify/EvidenceLinks.tsx` | 검증 상세의 Evidence 목록과 체크리스트 연결 저장 |
| `verify/model.ts` | 검증 화면 계산(정렬·필터·위치·Gate 행). 단위 시험 `test/verify-model.test.ts` |
| `verify/labels.ts` | 세 화면이 함께 쓰는 표시 이름·색 클래스·이동 주소(`LINK`) |
| `verify/screens.css` | 세 화면에만 필요한 추가 CSS. 규칙마다 이유를 적었다 |
| `history/HistoryPage.tsx` | 이력 화면 |
| `history/model.ts` | 이력 필터·건수 문구 계산. 단위 시험 `test/history-model.test.ts` |
| `shared/api/allPages.ts` | 쪽 나눔 목록을 끝까지 읽는 공통 query(이번에 새로 더함) |

## 3. 데이터 — 어떤 API를 언제 부르나

모든 요청과 응답 모양은 계약 타입(`@awbs/shared/api`)에서 뽑아 쓴다.

| 화면 | 요청 | 변경 이벤트 topic |
|---|---|---|
| 대시보드 | `GET /api/dashboard` | task·dependency·attempt·verification·message·proposal·planning·schedule·runner |
| 대시보드 | `GET /api/alerts`(「팀장 확인 필요」) | alert |
| 대시보드 | `GET /api/runner-state`(동시 실행 한도) | runner |
| 검증 | `GET /api/verifications`, `GET /api/evidence`(모든 쪽) | verification(·task) |
| 검증 | `GET /api/gates`, `GET /api/projects/:id/tasks`(제목·상태) | task·verification·attempt·ci / task |
| 검증 | `GET /api/tasks/:taskKey/attempts`(검증 Agent·실행 시도 번호) | attempt |
| 검증 상세 | `GET /api/tasks/:taskKey`(체크리스트) | task |
| 검증 상세 | `PATCH /api/tasks/:taskKey/checklist/:itemKey`(Evidence 연결 저장) | — |
| 이력 | `GET /api/history?from&to`(모든 쪽) | task·dependency·attempt·verification·message·proposal·planning·schedule |

### 3.1 「모든 쪽」을 읽는 이유

서버는 목록을 한 번에 최대 200건씩 나눠 준다(cursor, 다음 쪽 위치표).
화면은 `useAllPages`로 마지막 쪽까지 이어 읽는다.

- 왜: 탭의 건수, 「전체 N건 중」, 판정·Agent 필터는 모든 행을 알아야 서버와 일치한다(UAT-VERIFY-01 b).
- 예: 검증이 250건이면 두 쪽(200 + 50)을 읽고 탭에 「검증 결과 250」을 보인다.

### 3.2 이력은 어디서 거르나

- 기간(`from`·`to`)은 서버가 거른다. 날짜는 Asia/Seoul 기준이고 두 날짜 모두 포함이다.
  - 왜: 날짜 경계(시간대) 규칙을 서버 하나로 정해야 한다. 원본에는 기간 필터가 없었다(MM-18).
- 유형·주체·Task ID·검색은 받은 기간 안의 이력에서 화면이 거른다.
  - 왜: 유형·주체 버튼을 받은 이력에서 만들고, 「전체 N건 중」을 함께 보여 주기 위해서다.
- 끝 날짜가 시작보다 빠르면 서버에 보내지 않고 「끝 날짜가 시작 날짜보다 빠릅니다.」를 보인다(서버도 400으로 거부한다).

## 4. 저장 — Evidence ↔ 체크리스트 연결

검증 상세에서 체크리스트 항목 버튼(예: `CL-0007-1`)을 누르면 그 Evidence와 연결하거나 해제한다.

- 요청: `PATCH /api/tasks/TASK-0007/checklist/CL-0007-1` `{ updatedAt, evidence: "<Evidence id>" }`. 해제는 `evidence: null`.
- 편집 대상은 화면 위치(몇 번째 줄)가 아니라 안정 키로 정한다. 안정 키는 체크리스트 `itemKey`와 Evidence `id`다.
  - 왜: 목록이 다시 정렬되거나 항목이 늘어도 엉뚱한 항목을 바꾸지 않는다.
- 요청은 「토글」이 아니라 「이 값으로 바꿔라」라는 절대값이다.
  - 왜: 다시 시도·다시 적용 때 같은 요청이 두 번 가도 결과가 같다. 토글이면 두 번 눌러 원래대로 돌아간다.
- 공통 흐름을 그대로 쓴다(shared/README §3·§5).
  - `useSave`: 처리 중 버튼 잠금, 500·끊김은 오류 막대 「다시 시도」, 409 `VERSION_CONFLICT`는 충돌 창.
  - 충돌 창 「다시 적용」은 서버에서 최신 Task를 새로 읽고 그 `updatedAt`으로 같은 연결을 보낸다.
  - 저장에 실패한 연결 변경은 「저장하지 않은 연결 변경」으로 남는다. 이때 `useEditGuard`가 이동 전에 묻고, `useSessionDraft`가 세션 만료 뒤 복원을 제안한다.
  - M3-04가 공통 useSave에 `reapplyRequest`(결과 미확인 상태 공유)를 더하면, 다시 적용을 그 방식으로 바꾼다. 지금은 `onConflictReapply`에서 직접 보낸다.

### 4.1 Evidence 경로 추가

검증 상세 아래의 입력 칸에 저장소 상대 경로나 HTTP(S) 링크를 넣고 「Evidence 추가」를 누른다(원본 P L1945·6246–6252).

- 요청: `POST /api/verifications/<검증 id>/evidence` `{ path }`. 서버 후속 2차(keeproll/srv-followup2)의 계약이다.
- 빈 경로(공백만 있는 것 포함)는 버튼이 눌리지 않는다.
- 같은 검증에 이미 있는 경로는 보내지 않고 「이미 이 검증에 연결된 Evidence 경로입니다.」를 보인다. 서버도 중복을 400으로 거부한다.
- 서버가 형식을 거부하면(예: `../secret.txt`, `/etc/passwd`) 서버가 준 사유를 입력 칸 아래에 보이고 입력은 그대로 둔다.
  - 왜: 고칠 곳을 바로 알려 주고, 쓴 글자를 잃지 않게 한다.
- 입력 중인 경로는 초안이다. 다른 화면으로 가기 전에 묻고(편집 보호), 세션이 끊겨 다시 로그인하면 복원을 제안한다.
- 경로 Evidence는 서버가 파일을 읽지 않은 「참조」다. 그래서 지문·크기가 없고 「원본 내려받기」 버튼도 없다. 종류는 원본처럼 확장자로 정한다(예: `.json` → 측정 데이터).

### 4.2 검증 결과에 없는 체크리스트 Evidence(고아 경고)

원본과 같은 판정이다(P L6354–6355).

- 체크리스트 항목의 evidence 값(Evidence id 또는 경로)이 같은 Task의 「검증에 속한 Evidence」 어디에도 없으면 Evidence 탭 아래에 경고한다.
- 이를 위해 체크리스트가 있는 Task의 상세(`GET /api/tasks/:taskKey`)를 읽는다. 읽지 못하면 「체크리스트를 불러오지 못해 … 판정할 수 없습니다」와 「다시 시도」를 보인다.
  - 왜: 조회 실패를 「경고 없음(정상)」으로 보이면 잘못 연결된 증거를 놓친다.
- 예: TASK-0007의 CL-0007-2가 `review-orphan/path.txt`를 가리키는데 그 경로의 Evidence가 검증에 없으면 「TASK-0007 CL-0007-2 → review-orphan/path.txt」.

### 4.3 조회 일부가 실패했을 때

- 실행 시도 조회(Agent·실행 시도 번호)가 실패하면 오류 막대와 「다시 시도」를 보인다.
- Agent를 모르는 검증이 있으면 Agent 필터 결과를 「조건에 맞는 결과 없음」으로 단정하지 않고 「Agent 정보를 불러오지 못한 검증 N건」을 따로 보인다.
- 대시보드 본문(`GET /api/dashboard`) 조회가 실패하거나 아직 오지 않아도, 따로 받은 경고(`GET /api/alerts`)는 그대로 보인다.

## 5. 원본과 다른 점

| 곳 | 원본 | 제품 | 왜 |
|---|---|---|---|
| 모든 항목 | button | 주소가 있는 링크(a) | 새로고침·뒤로 가기·새 탭(MM-29) |
| 대시보드 알림 | 「실행 보기」·「확인」 | 대상별 이름(「TASK-0007 실행 보기」「프로젝트 보기」 등), 「확인」 없음 | 알림을 닫는 팀장 API가 계약에 없다 |
| 대시보드 패널 왼쪽 칸 | PLN-001·CP-002·ATT-0004-2 | Planning·CP·TASK-0004 | 대시보드 계약에 표시 번호가 없다 |
| 최근 결과 3·4번째 칸 | ID·Task | Task·Agent | 같은 이유 |
| 검증 ID | 서버 값 V-0007-1 | 같은 Task 검증을 시각 순서로 센 표시 번호 | 계약에 검증 표시 번호가 없다. 검증은 덧붙이기만 해서 번호가 바뀌지 않는다. 선택·주소에는 서버 id를 쓴다 |
| Evidence 이름 | 파일 경로 | 팀장이 추가한 경로는 그대로, Runner 파일은 「종류 · 지문(sha256) 앞 12자리」 + 「원본 내려받기」 | Runner 업로드 Evidence에는 경로가 없다 |
| Gate 조건 사유 | 마우스를 올려야 보임(title) | title + 화면 읽기 프로그램용 글자 | 접근성 |
| 이력 필터 | 검색·Task·유형·주체 | + 기간 시작·끝 | MM-18, G L336 |
| 빈 상태 | 「아직 … 없습니다.」 | 같은 문구 + 생기는 조건 안내, 조건 불일치에는 「필터 초기화」 | UAT-EMPTY-04 |

## 6. 이동 주소 규칙(`LINK`)

주소는 공통 주소 표 `src/shared/links.ts`의 `LINK`로 만든다(M3 통합). `labels.ts`의 `LINK`는 그것을 그대로 내보낸다.
M3 통합에서 받는 화면과 어긋난 주소를 고쳤다(작업 실행·Planning).

- Task 상세: `/wbs/TASK-0007?tab=verif`(탭 이름은 M3-03: overview·checklist·verif·hist·msg)
- WBS 필터: `/wbs?status=done`, `?status=active`, `?blocked=y`, `?type=Implementation`, `?domain=FE`, 보기 `?view=gantt`
  - 이름은 M3-02 `Filters`의 필드 이름과 같다. WBS 화면이 처음 그릴 때 주소에서 읽는다(M3 통합).
- 작업 실행: `/exec/TASK-0007?att=<시도 id>`(M3-06 주소). 작업 실행 화면은 시도 키와 시도 id를 모두 받는다.
- 변경 제안: `/change/<CP 키 또는 id>`, Planning: `/planning?session=<id>`(M3-05 주소)
- 설정 탭: `/settings/runner`, `/settings/report`, `/settings/notify`

## 7. 시험

| 명령 | 확인하는 것 |
|---|---|
| `W e2e -- verify history dashboard` | **M3-07 완료 조건.** 가짜 API로 UAT-VERIFY-01~03, HISTORY-01, DASH-01, STATE-01, TASK-11, EMPTY-04, PROJECT-11(대시보드 부분), D-28·390px |
| `W --filter @awbs/web e2e:api:m307` | 실제 API·전용 DB(demo seed + Evidence 1건)로 검증 건수·Gate·Evidence 연결·경로 추가·고아 경고·이력 기간 필터·대시보드 숫자. 대시보드·경로 추가 API가 있는 서버(서버 후속 2차 이후)에서 실행 |
| `W e2e -- visual-m307` | 원본 스크린샷과 시각 비교(§8) |
| `W test` | 계산 모델 단위 시험 |

- `e2e:api:m307`은 전용 PostgreSQL 컨테이너(`m307-e2e-pg-…`)를 빈 포트에 띄우고 끝나면 지운다. 개발 DB는 건드리지 않는다.
- 다른 작업과 동시에 E2E를 돌리면 화면 포트 5183이 겹칠 수 있다. 그때는 `AWBS_E2E_PORT=5307`처럼 다른 포트를 준다.

## 8. 시각 비교

`e2e/visual-m307.spec.ts`가 원본과 같은 조건으로 구현 화면을 찍어 같은 영역을 비교한다.

- 조건: viewport 1920×1080(일부 1280×800), 기기 배율 1, ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST, 애니메이션 끔.
- 데이터: 원본 Mock과 같은 값의 가짜 API(`e2e/support/m307-data.ts`).
- 대시보드 전체 사진은 원본과 같은 방법으로 찍는다. 본문 안쪽 스크롤 길이만큼 viewport를 늘려 한 장에 담는다.
- 차이 계산: pixelmatch, 색 차이 기준 `threshold 0.1`, 안티에일리어싱(글자 가장자리 번짐) 픽셀은 세지 않는다.
- 합격 기준: 같아야 하는 영역은 차이 2%(표가 긴 영역은 3%) 이하. 넘으면 시험이 실패한다.
- 예외(기록만): §5의 제품 결정으로 글자가 다른 영역(대시보드 알림·패널·최근 결과, 검증 상세, Evidence 표, 이력 도구 막대).
- 결과: `~/.orca/bots/agentwbs/archive/2026-11-26/M3-07/visual/`에 `[원본 | 구현 | 차이]` 이미지와 `summary.md`.

## 용어집

| 용어 | 뜻 |
|---|---|
| Evidence | 검증 결과를 뒷받침하는 증거 파일. Runner가 올린다 |
| Completion Gate | Task를 완료로 넘기기 전 5조건(체크리스트·산출물·검증·차단 결함·승인) 검사 |
| cursor | 목록의 다음 쪽 위치를 가리키는 표. 서버가 주고 화면은 그대로 돌려보낸다 |
| 안정 키 | 화면 위치와 상관없이 대상을 하나로 정하는 값. 예: 체크리스트 `itemKey`, Evidence `id` |
| 표시 번호 | 사람이 읽기 쉽게 붙인 번호(예: V-0007-1). 서버 id와 다르다 |
| 지문(sha256) | 파일 내용으로 계산한 고유 값. 같은 파일인지 확인할 때 쓴다 |
| 레일 | 상세를 볼 때 왼쪽에 좁게 남는 목록 |
| 펼치기 | 상세를 닫고 넓은 목록으로 돌아가기 |
| topic | 변경 이벤트 종류. 그 종류가 바뀌면 관련 데이터만 다시 읽는다 |
| skeleton | 데이터가 오기 전 화면 배치 모양만 회색으로 먼저 보이는 로딩 표시 |
| pixelmatch | 두 그림의 픽셀을 비교해 다른 픽셀 수를 세는 도구 |
