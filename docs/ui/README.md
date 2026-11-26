# docs/ui 안내서 — 처음 읽는 사람을 위한 길잡이

이 폴더는 Agent WBS 제품의 **화면(UI) 기준 문서**를 모아 둔 곳이다.
프로토타입(먼저 만들어 본 시험용 화면)을 꼼꼼히 조사한 기록과, 실제 제품이 무엇을 해야 "완성"인지 판정하는 기준이 함께 들어 있다.

처음 오면 이 문서부터 읽는다.
여기에는 읽는 순서, ID 읽는 법, 마일스톤과의 관계, 자주 나오는 용어 풀이(용어집)가 있다.

> 이 안내서는 다른 문서의 내용을 새로 정하지 않는다.
> 내용이 서로 다르게 보이면 각 문서 본문과 계획 문서(`docs/plan/`)가 우선이다.

## 1. 이 폴더가 답하는 질문

| 질문 | 보는 문서 |
|---|---|
| 프로토타입에는 어떤 화면·탭·모달이 있고, 버튼을 누르면 무엇이 바뀌나? | [inventory.md](inventory.md) |
| 제품이 "완성"이라고 말하려면 무엇을 확인해야 하나? | [acceptance.md](acceptance.md) |
| 목록이 비었을 때나 오류가 났을 때는 어떻게 판정하나? | [acceptance-coverage.md](acceptance-coverage.md) |
| 프로토타입과 가이드가 서로 다르거나, 프로토타입이 틀린 곳은 어디인가? | [mismatches.md](mismatches.md) |
| 각 화면은 어떤 데이터를 읽고 바꾸나? | [data-needs.md](data-needs.md) |
| 색·글꼴·간격·반응형 규칙 같은 디자인 값은 무엇인가? | [design-tokens.md](design-tokens.md) |
| 각 판정 항목(UAT)은 어느 마일스톤에서 통과해야 하나? | [milestone-audit.md](milestone-audit.md) |
| 프로토타입 화면 사진은 어디 있나? | [screenshots.md](screenshots.md) |
| 리뷰 지적은 어떻게 처리했나? | [review-response.md](review-response.md), [review-2-response.md](review-2-response.md) |
| 조사 결과를 무엇으로 확인했나? | [evidence/verification.md](evidence/verification.md), [evidence/browser.md](evidence/browser.md) |

## 2. 읽는 순서

처음이라면 아래 순서를 권한다.
앞 문서가 뒤 문서의 단어와 ID를 설명해 주기 때문이다.

1. **이 README** — 용어와 ID 읽는 법을 먼저 익힌다.
2. **[inventory.md](inventory.md)의 머리말** — 화면 ID가 어떻게 붙었는지, 프로토타입이 어떤 구조인지 안다.
3. **[mismatches.md](mismatches.md)** — 프로토타입을 그대로 따라 하면 안 되는 곳(MM-01~MM-31)을 안다.
4. **[acceptance.md](acceptance.md)** — 제품이 통과해야 할 판정 항목(UAT) 전체를 본다.
5. **[acceptance-coverage.md](acceptance-coverage.md)** — 빈 화면·오류 화면의 판정 근거를 본다.
6. **[milestone-audit.md](milestone-audit.md)** — 각 UAT를 언제(어느 마일스톤에서) 통과해야 하는지 본다.
7. 필요할 때 찾아보기: [data-needs.md](data-needs.md), [design-tokens.md](design-tokens.md), [screenshots.md](screenshots.md).
8. 배경이 궁금할 때: 리뷰 처리 기록 2개와 `evidence/` 폴더.

구현 담당자라면 4 → 6 → 3 순서로 다시 보는 것이 좋다.
"무엇을 언제까지 통과해야 하는지"를 먼저 알고, "프로토타입의 어떤 부분을 고쳐서 만들어야 하는지"를 그다음에 확인하기 위해서다.

## 3. 판정 우선순위

여러 문서가 서로 다른 말을 하면 아래 순서로 따른다.

**owner 결정 → 계획 기준선 a60216d → 가이드 → 원본(프로토타입)**

- 왜 이렇게 하나: 프로토타입은 "보여 주기용"이라 결함과 가짜 버튼이 섞여 있다. 그래서 가장 나중에 따른다.
- 예: 프로토타입은 Task를 완료할 때 서버 검사 없이 바로 done으로 저장한다(MM-01). 하지만 가이드와 계획은 검사를 요구하므로 제품은 검사를 해야 한다.

## 4. ID 읽는 법

### 4.1 화면 ID

화면 ID는 [inventory.md](inventory.md)에서 붙인 고정 이름표다.
화면 이름이 바뀌어도 ID는 그대로 두어 문서끼리 서로 가리킬 수 있게 한다.

| 모양 | 뜻 | 예 |
|---|---|---|
| `UI-01`~`UI-12` | 왼쪽 메뉴의 실제 12개 메뉴 화면 | `UI-03` = WBS 목록 화면 |
| `UI-02A`, `UI-02B` | 프로젝트 메뉴 자리에 대신 나오는 화면(등록, 초기 분석) | `UI-02A` = 프로젝트 등록 |
| `UI-03-01` 처럼 `-번호`가 붙은 것 | 그 화면 안의 탭 | `UI-03-01` = Task 개요 탭 |
| 끝에 영문자가 붙은 것 | 그 화면·탭 안의 패널·편집기·메뉴, 모달 안의 단계 | `UI-03-01A`, `MOD-06A` |
| `UI-13` | 정상 메뉴로는 열리지 않는 대체 화면 | 제품에서 만들지 않는다 |
| `UI-00` | 앱 전체를 감싸는 틀(헤더·왼쪽 메뉴) | — |
| `MOD-*` | 모달(화면 위에 뜨는 창) | `MOD-08` = 공용 확인창 |
| `SYS-*` | 모든 화면이 함께 쓰는 공통 상태(로딩·오류 등) | `SYS-01` |
| `UI-AUTH` | 로그인 화면. 원본에는 없고 owner가 추가했다 | — |

### 4.2 UAT ID (판정 항목)

UAT(User Acceptance Test, 사용자 인수 시험)는 "이것이 되면 완성으로 인정한다"는 판정 항목이다.
모양은 `UAT-<업무 이름>-<번호>`이다.

- 예: `UAT-TASK-06` = Task 업무의 6번째 판정 항목.
- 앞에 `UAT-`를 붙이는 이유: 화면 ID(`UI-…`)와 헷갈리지 않게 하려고.
- 끝에 붙는 꼬리표의 뜻:
  - `-UI`: M3에서 화면·API만 먼저 판정하는 항목. 예: `UAT-PROJECT-UI`.
  - `-RUNNER`: 실제 Runner까지 붙여서 판정하는 항목. 예: `UAT-EXEC-09-RUNNER`.
  - `-CI`: CI 화면 이동을 따로 떼어 낸 항목. 예: `UAT-TASK-10-CI`.
- 한 UAT의 기대 결과가 a), b), c)로 나뉘어 있으면 **모두** 만족해야 통과다. 하나라도 실패하면 그 UAT 전체가 미통과다.

### 4.3 그 밖의 ID

| 모양 | 뜻 | 정의한 문서 |
|---|---|---|
| `MM-01`~`MM-31` | 불일치 항목(MisMatch). 원본과 가이드·제품 기대가 다른 곳 | [mismatches.md](mismatches.md) |
| `EV-0001` 형식 | 원본 템플릿의 이벤트(버튼 클릭 등) 발생 위치 하나 | [inventory.md](inventory.md) 생성 영역 |
| `CD-0001` 형식 | 원본의 조건 분기(`sc-if`) 하나. 추적용이며 합격 항목이 아니다 | 같은 곳 |
| `LP-0001` 형식 | 원본의 반복(`sc-for`) 하나 | 같은 곳 |
| `D-27`, `Q-01` 등 | 계획 문서의 결정 번호(D)와 질문 번호(Q) | `docs/plan/architecture.md`, `docs/plan/open-questions.md` |
| `M3-04` 등 | 마일스톤 작업 ID(단계 3의 4번째 작업) | `docs/plan/milestones.md` |

### 4.4 줄 번호 읽는 법

문서에는 근거 위치가 짧은 기호로 적혀 있다.

- `P744`: 원본 프로토타입 `prototype/uiux/Main.dc.html`의 744번째 줄.
- `G86`: 구현 가이드 `prototype/docs/Agent-WBS-설계의도-및-구현가이드.md`의 86번째 줄.
- `L16`: design-tokens.md 부록에서 쓰는 원본 줄 번호 표시(`/* L16 */`).
- 기호 없이 `3689–3699`처럼 숫자만 있으면 문맥상 원본(P) 줄 범위다. 문서 머리말에 다른 뜻이 적혀 있으면 그 설명을 따른다.

## 5. 마일스톤과의 관계

계획(`docs/plan/milestones.md`, 기준 커밋 a60216d)은 일을 M0~M8 단계로 나눈다.

| 단계 | 이름 |
|---|---|
| M0 | 기반 |
| M1 | 데이터 · 계약 · 순수 판정 |
| M2 | 서버 핵심 |
| M3 | 핵심 화면 (M2 API 사용) |
| M4 | Runner 기반 |
| M5 | 실행 · Planning |
| M6 | 보고서 · 알림 · 설계 |
| M7 | 빌드 · 통합 |
| M8 | 통합 · 실환경 인수 |

- 단계 순서: M0 → M1 → M2 → M3, M1 → M4, M2·M4 → M5, M3·M5 → M6, M5 → M7, M6·M7 → M8.
- 각 UAT에는 **필수 통과 마일스톤이 딱 하나** 있다. [acceptance.md](acceptance.md)의 "필수 통과 마일스톤" 표에서 확인한다.
  - 왜 하나만 두나: 같은 항목을 여러 단계에 걸쳐 "조금씩 통과"로 체크하면 언제 끝났는지 알 수 없기 때문이다.
- 앞 단계에서 가짜 데이터(fixture)로 성공했다고 뒤 단계 항목을 체크하지 않는다.
  - 예: M3에서 화면이 fake Runner 보고로 잘 보여도, 실제 Runner가 필요한 M5 항목은 M5에서 따로 통과해야 한다.
- 각 UAT가 화면·API·Runner 기능이 준비된 뒤에 배치됐는지는 [milestone-audit.md](milestone-audit.md)에서 기계적으로 대조했다.

## 6. 생성되는 부분과 손으로 쓴 부분

몇몇 문서는 아랫부분이 스크립트로 만들어진다.
그 부분은 직접 고치지 않는다.

| 문서 | 생성 표시 | 만드는 스크립트 | 입력 |
|---|---|---|---|
| inventory.md, acceptance.md, data-needs.md, design-tokens.md | `<!-- GENERATED: extract.py -->` 아래 | [extract.py](extract.py) | 원본 HTML, [catalog.tsv](catalog.tsv), [acceptance-cases.tsv](acceptance-cases.tsv), [evidence/data-model.json](evidence/data-model.json) |
| milestone-audit.md | `<!-- AUDIT-GENERATED -->` 아래 | [audit-milestones.py](audit-milestones.py) | [acceptance-cases.tsv](acceptance-cases.tsv), 계획 a60216d |

- 생성 영역의 문구를 바꾸고 싶으면 입력 파일(TSV)이나 스크립트를 고친 뒤 다시 생성한다.
- 다시 생성하는 명령과 확인 명령:

```sh
python3 docs/ui/extract.py            # 다시 생성
python3 docs/ui/extract.py --check    # 문서가 최신인지 확인만
python3 -B docs/ui/audit-milestones.py
python3 -B docs/ui/audit-milestones.py --check
```

- `--check`가 실패하면 누군가 생성 영역을 손으로 고쳤거나, 입력을 바꾸고 다시 생성하지 않은 것이다.
- `node docs/ui/probe.mjs`는 [evidence/data-model.json](evidence/data-model.json)을 **다시 쓰는** 명령이다. 원본이 실제 시계를 쓰기 때문에, probe는 기존 증거를 만든 시각 **2026-11-25 21:21 Asia/Seoul**로 시계를 고정해 실행한다. 그래서 언제 실행해도 같은 JSON이 나온다. 기존 문서가 최신인지 확인만 할 때는 `extract.py --check`를 쓴다.

## 7. 용어집

문서에서 자주 나오는 말을 가나다·알파벳 순으로 모았다.
각 문서에서도 처음 나올 때 짧게 풀어 쓴다.

### 사람·문서·기준

| 용어 | 뜻 |
|---|---|
| owner | 이 제품의 최종 결정권자. owner 결정은 모든 문서보다 우선한다. |
| coordinator | 여러 작업자에게 일을 나눠 주고 결과를 모으는 조정 역할. |
| 계획 기준선 (a60216d) | `keeproll/plan-baseline` 브랜치의 커밋 a60216d에 있는 계획 문서 묶음. 지금의 판정 기준이다. |
| 가이드 (G) | `prototype/docs/Agent-WBS-설계의도-및-구현가이드.md`. 설계 의도를 설명한 문서. |
| 원본 (P) | 프로토타입 HTML 파일 `prototype/uiux/Main.dc.html`. "보여 주기용" 시험 화면이다. |
| 독립 리뷰 | 이 문서를 쓴 사람이 아닌 다른 리뷰어(Claude)가 브라우저로 원본을 직접 확인한 검토. |
| 인수 / 인수 기준 | 제품을 "완성"으로 받아들이는 일과 그 판단 기준. |
| 판정 ID | 판정 항목의 ID. 대부분 UAT ID를 말한다. |
| gate (owner gate) | owner가 결정하거나 허락해야 다음으로 넘어갈 수 있는 관문. 업무 용어 Gate와 다르다. |

### 업무 용어

| 용어 | 뜻 |
|---|---|
| WBS | Work Breakdown Structure. 프로젝트를 Phase → Work Package(WP) → Task로 쪼갠 작업 목록. |
| Phase / WP | WBS의 큰 단계 / 그 안의 작업 묶음. |
| Task | 실제로 실행하는 가장 작은 작업 단위. `TASK-0001`처럼 ID가 있다. |
| Agent | Task를 실행하는 AI(Claude, Codex). |
| 하위 Agent (subagent) | Agent가 일하면서 다시 띄우는 보조 Agent. |
| Runner | 팀장 PC에서 Agent를 실제로 실행하고 결과를 서버에 보고하는 프로그램. |
| 실행 시도 (Attempt) | Task를 한 번 실행한 기록. 다시 실행하면 새 시도가 생긴다. |
| 실행 등급 | Agent에 쓸 모델과 Effort(생각의 깊이 단계)의 조합. |
| Gate | Task를 완료로 넘기기 전에 통과해야 하는 검사 묶음. owner gate와 다르다. |
| Evidence | 검증 결과를 뒷받침하는 증거 파일. |
| QA / 재검증 | 품질 검사 / 고친 뒤 다시 하는 검사. |
| 재작업 (rework) | 검사에서 실패한 Task를 다시 고치는 실행. |
| BLOCKED | 검증을 진행할 수 없는 상태. 원인을 해결한 뒤 새 검증 시도를 한다. |
| 착수 승인 | Task 명세를 확인하고 실행해도 된다고 허락하는 단계(owner Q-02). |
| Planning | Planning Agent가 일정·범위를 분석하고 변경을 제안하는 기능. |
| CP (Change Proposal) | WBS를 바꾸자는 변경 제안. 승인을 받아야 반영된다. |
| 재조정 (replan, RP) | 일정 기준을 다시 계산하는 일. RP는 재조정 기록 ID다. |
| 기준선 (baseline) | 비교 기준이 되는 일정·계획 버전. |
| FS / SS | 의존성 종류. FS(Finish-to-Start)는 선행이 끝나야 후속 시작, SS(Start-to-Start)는 선행이 시작해야 후속 시작. |
| 선행 / 후속 | 먼저 해야 하는 Task / 그 뒤에 하는 Task. |
| ① Task 검사 / ② 통합 확인 | CI의 두 단계. ①은 Task 하나의 변경을 검사하고, ②는 main에 합칠 때 전체를 확인한다. |
| 병합 대기열 | 검증된 PR이 main에 합쳐지기를 기다리는 줄. |
| 불안정 테스트 (flaky) | 같은 코드인데도 통과·실패가 오락가락하는 테스트. |
| 초기화 / cleanup | 프로젝트를 처음 상태로 되돌리는 일 / 그 뒤 원격 브랜치·PR 등을 정리하는 일. |
| epoch | 초기화할 때마다 올라가는 세대 번호. 옛 세대의 요청을 거르는 데 쓴다. |

### 시험·검증 용어

| 용어 | 뜻 |
|---|---|
| UAT | User Acceptance Test. 사용자 인수 시험. "완성" 판정 항목. |
| fixture | 시험을 위해 미리 준비해 두는 데이터나 상황. |
| fake Runner / fake CLI | 진짜 대신 정해진 보고만 돌려주는 시험용 가짜 프로그램. 제품의 성공 근거가 아니다. |
| Mock | 원본 프로토타입에서 실제 연결 없이 흉내만 내는 동작이나 버튼. 제품 기능이 아니다. |
| E2E | End-to-End. 실제 화면을 열고 클릭·키보드로 끝까지 확인하는 시험. |
| API+E2E | 저장·검증·다시 조회까지 서버 API와 화면을 함께 확인하는 시험. |
| 시각·수동 | 사람이 화면·인쇄·포커스를 눈으로 확인하는 검수. |
| VM 확인 | [probe.mjs](probe.mjs)로 원본 JavaScript를 Node 가상 환경(VM)에서 실행해 확인한 결과. 브라우저 확인과 다르다. |
| 정적 추출 | 프로그램을 실행하지 않고 파일 내용만 읽어 뽑아낸 결과. |
| 체크섬 (SHA-256) | 파일 내용으로 계산한 고유 값. 원본이 바뀌지 않았는지 확인할 때 쓴다. |
| AC (Acceptance Criteria) | Task의 완료 인정 조건. "이것이 되면 이 Task는 끝"이라는 조건 목록. |
| Given / When / Then | AC를 쓰는 형식. Given=전제(시작 상황), When=동작(사용자가 하는 일), Then=기대 결과. |
| Diff | 바뀌기 전과 후를 나란히 비교해 보여 주는 것. CP에서는 WBS가 어떻게 바뀌는지 보여 준다. |
| KPI | 핵심 지표(Key Performance Indicator). 대시보드 위쪽의 일정·진척 숫자들. |

### 기술 용어

| 용어 | 뜻 |
|---|---|
| CLI | 명령줄 프로그램. 여기서는 Claude·Codex 실행 프로그램을 말한다. |
| API | 화면(브라우저)과 서버가 데이터를 주고받는 약속된 창구. 예: `POST /api/replans/run`. |
| Endpoint | API 하나하나의 "방식+주소" 한 쌍. 예: `POST /api/replans/run`. "중복 Endpoint"는 같은 방식·주소를 두 번 정의한 것이다. |
| HTTP 메서드 | API 요청의 종류. GET(조회), POST(생성·실행), PUT/PATCH(수정), DELETE(삭제) 등. |
| PK (기본키) | DB 표에서 각 행을 하나로 구분하는 열. 비어 있으면 안 된다. "nullable PK"는 기본키에 '값 없음(null)'을 허용한 잘못된 설정이다. |
| FK (외래키) | 다른 표의 행을 가리키는 열. "없는 FK"는 존재하지 않는 표나 열을 가리키는 잘못된 설정이다. |
| 인덱스 | DB에서 검색을 빠르게 하려고 특정 열에 만들어 두는 색인. "없는 인덱스 컬럼"은 표에 없는 열로 인덱스를 만든 경우다. |
| nullable / null | null은 '값 없음'. nullable은 그 열에 '값 없음'을 허용한다는 뜻이다. |
| ack | 상대가 "받았다"고 돌려주는 확인 신호. 받았다는 뜻일 뿐 일을 끝냈다는 뜻은 아니다. |
| readiness (준비 상태) | Runner가 실행 전에 점검하는 항목(CLI 로그인, 버전 등)의 결과. ok/warn/fail로 나온다. |
| 슬롯 / 보유 | 슬롯은 동시에 돌릴 수 있는 실행 자리 하나. 보유는 그 자리를 "아직 사용 중"으로 잡아 두는 것이다. 같은 PC에서는 프로세스가 정말 끝난 것이 확인돼야 자리를 돌려준다(해제). PC가 바뀐 경우의 예외(옛 PC 보유는 새 PC 재개를 막지 않고, GitHub 쓰기만 따로 막음)는 계획 contracts §3.4-5를 따른다. |
| 하위 Agent 예산 / 관측 수 | 예산은 지시문에 적는 "하위 Agent를 동시에 최대 몇 개까지". 관측 수는 CLI 출력에서 실제로 보인 하위 Agent 수. 관측을 믿을 수 없는(미검증) CLI는 둘 중 큰 값 `max(예산, 관측)`을 사용 중으로 센다. 예: 예산 2, 관측 3이면 3으로 센다. |
| liveInject (즉시 전달) | 실행 중인 Agent에게 메시지를 바로 넣는 기능. 지원하지 않으면 메시지는 다음 실행 때 전달된다. |
| head | 브랜치의 최신 커밋. "같은 head"는 검사한 커밋과 병합할 커밋이 같다는 뜻이다. |
| CI | Continuous Integration. 코드를 자동으로 빌드·검사하는 파이프라인. |
| PR | Pull Request. 변경을 main에 합쳐 달라는 요청. |
| main | 저장소의 기본 브랜치. |
| heartbeat | Runner가 "살아 있다"고 주기적으로 보내는 신호. |
| SMTP / Bot API | 메일 발송 규약 / Telegram 봇에 메시지를 보내는 인터페이스. |
| skeleton | 데이터가 오기 전에 화면 배치 모양만 회색으로 먼저 보여 주는 로딩 표시. |
| 멱등성 | 같은 요청을 여러 번 보내도 결과가 한 번 보낸 것과 같은 성질. |
| append-only | 기록을 덧붙이기만 하고 고치거나 지우지 않는 저장 방식. |
| snapshot | 특정 시점의 내용을 그대로 굳혀 둔 사본. |
| loopback | 같은 PC 안에서만 접속하는 주소(127.0.0.1). |
| LAN | 같은 사무실 네트워크. |
| viewport | 브라우저에서 실제로 보이는 화면 영역. |
| 디자인 토큰 | 색·간격·크기 같은 디자인 값에 이름을 붙여 한곳에서 관리하는 방식. 자세한 설명은 [design-tokens.md](design-tokens.md). |
| 오류 코드 예 | `500`(서버 오류), `400`(입력 검증 실패), `404`(없음), `409`(버전 충돌), `429`(요청이 너무 많음), `503`(일시적으로 사용 불가). |
