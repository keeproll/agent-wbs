# 용어집

`docs/plan/` 문서에 나오는 용어와 약어를 모았다. 영문·기호로 시작하는 말을 먼저 알파벳순으로 두고, 이어서 한글 용어를 가나다순으로 두었다. 뜻풀이는 이 프로젝트에서 쓰는 뜻이다. 자세한 규칙은 「→」 뒤의 문서 절에 있다.

[README로 돌아가기](README.md)

## 기호

- **①②③④** — 빌드·통합(CI) 4단계다. ① Task 검사, ② 통합 확인, ③ 야간 점검, ④ 배포 확인. → milestones §3 M7
- **★** — contracts.md에서 가이드에 없는 설계 결정(보강)을 표시한다. → contracts 머리말
- **∥ / —** — milestones.md의 병렬 표시. `∥`는 같은 마일스톤 안에서 동시에 할 수 있음, `—`는 선행 작업을 기다림. → milestones §1
- **§** — 가이드(G)의 절 번호. 예: `G§4.2`는 가이드 4.2절. 「contracts §3.4」처럼 문서 이름이 붙으면 그 문서의 절이다.

## A–Z

- **A / H / H'** — 병합 절차에서 쓰는 커밋 기호. A는 병합 직전 main, H는 QA가 검사한 PR head, H'는 H에 A를 충돌 없이 합친 커밋(H가 A를 포함하면 H'=H). → contracts §4.1
- **A4** — 국제 표준 종이 크기(210×297mm). 보고서 PDF 크기다.
- **AC (Acceptance Criteria, 수용 기준)** — 「이렇게 되면 완료로 인정한다」는 조건. given/when/then/method로 적는다. → data-model §2.3
- **Administration: read (GitHub 권한)** — 저장소 관리 정보를 읽기만 하는 fine-grained 토큰 권한. Runner는 deploy key 목록을 확인하려고 이 권한을 쓴다. 설정을 바꾸는 권한은 아니다. → open-questions Q-09, contracts §3.1
- **advisory lock** — 행이 아니라 앱이 정한 번호(예: 프로젝트)에 거는 PostgreSQL 잠금. 동시에 의존성을 추가할 때 한 건씩 검사하게 한다.
- **AES-256-GCM** — 비밀값을 암호화하는 표준 방식. 키 하나로 암호화·복호화하며 내용이 바뀌었는지도 함께 검사한다.
- **AAD (Additional Authenticated Data)** — 암호화하지 않지만 위조 검사에 함께 넣는 데이터. 봉인 형식 v1은 버전 바이트와 임시 공개키를 AAD로 쓴다. → contracts §6.1
- **Agent** — 일을 하는 AI 프로그램. 이 프로젝트에서는 Claude와 Codex다.
- **Agent Runner (Runner)** — 개발 PC에서 Agent 세션을 실행하고 결과를 보고하는 프로그램(`agent-runner/`). 판정은 하지 않는다. → architecture §1
- **Agent WBS (WBS)** — 팀장용 웹 화면·REST API·PostgreSQL로 된 시스템(`agent-wbs/`). 모든 판정을 한다. → architecture §1
- **aggregate (비교 대상)** — 동시 수정을 막을 때 버전을 비교하는 기준 행. → contracts §1.3
- **AI** — 인공지능. 이 프로젝트에서 AI Agent는 Claude·Codex다.
- **allowlist** — 허용 목록에 있는 것만 통과시키는 방식. Agent에 넘기는 환경 변수를 이렇게 고른다. → architecture §4
- **API** — 프로그램끼리 요청·응답을 주고받는 약속된 창구.
- **argv** — 명령 이름과 인자를 배열로 하나씩 넘기는 방식. shell을 거치지 않아 입력값이 명령으로 해석되지 않는다.
- **AsyncAPI** — 메시지(이벤트) 기반 API를 적는 표준 형식. → open-questions Q-14
- **attempt (시도)** — Agent가 Task를 한 번 실행하는 단위. 종류는 dev·qa·rework·reverify. → data-model §3.2
- **Avro / Protobuf** — 메시지(이벤트) 데이터의 모양을 정의하는 스키마 형식. Q-14 선택지 (C)에 나온다.
- **awbs-agent (Agent 전용 계정)** — Agent(Claude·Codex)만 쓰는 리눅스 계정. 로그인 셸과 sudo 권한이 없고 Runner 홈을 읽지 못한다(owner Q-08 B). → architecture §4 「실행 격리」
- **`awbs_notify_emit()`** — 알림 기록과 Telegram 발송 대기열을 같은 트랜잭션에서 만드는 DB 공통 함수(마이그레이션 0036). 모든 알림이 이 함수 하나를 지난다. → data-model §3.7
- **awbs_app_login (앱 DB 로그인)** — 운영 api·worker가 쓰는 DB 로그인. `awbs_app` 권한만 물려받고 `SET ROLE`은 못 한다. 관리자 로그인 `awbs_owner`는 마이그레이션·백업·복원에만 쓴다. → data-model §6.1, docs/ops/operations.md §3.3
- **`AWBS_REPORT`** — ③④ 단계 명령이 결과를 JSON으로 쓰는 파일의 경로를 담은 환경 변수. 보고서에는 이번 시도의 `AWBS_REPORT_NONCE` 값을 그대로 적어야 한다. → contracts §3.6-3
- **base64url** — 바이트를 URL에 안전한 글자(A–Z, a–z, 0–9, `-`, `_`)로 바꿔 적는 방식. 봉인 값은 끝의 `=`(padding) 없이 쓴다. → contracts §6.1
- **bare 저장소** — 작업 폴더 없이 git 기록만 담은 저장소. 테스트에서 원격 저장소 대신 쓴다.
- **Bearer** — `Authorization: Bearer <토큰>` 헤더로 토큰을 보내 인증하는 방식.
- **bigserial** — PostgreSQL에서 자동 번호를 발급하는 큰 정수 열. 실패·취소로 중간 번호가 비기도 한다. 다음 번호가 꼭 현재+1이라고 가정하면 안 된다.
- **blob (git blob)** — git이 파일 내용 하나를 저장하는 단위. 그 SHA로 「내용이 같은지」를 비교한다. 실행 권한만 바뀌면 blob은 그대로다. → contracts §3.1 입력 변경 보고
- **BLOCKED** — 검증 결과의 하나. 환경 문제 등으로 판정하지 못했다는 뜻이며 Task 상태는 그대로 두고 새 검증 시도를 한다. → data-model §3.1
- **boot ID** — PC가 켜질 때마다 새로 바뀌는 식별자. 바뀌었으면 이전 프로세스가 살아 있을 수 없다는 증거가 된다. → contracts §3.4
- **bootstrap (초기 분석)** — 저장소를 등록한 뒤 Planning이 처음 WBS 초안을 만드는 작업. → data-model §2.2
- **Bot API (Telegram)** — Telegram 봇으로 메시지를 보내는 HTTP API. 봇 토큰이 필요하다.
- **`budgetsMs`** — `pipeline.yaml`의 `night` 단계에 둘 수 있는 선택 필드. 주요 API 이름별 응답 시간 p95 기준(ms)이다. main에 고정된 정의에서만 읽는다. → contracts §3.6-3
- **C.UTF-8** — 문자열 정렬·문자 분류 규칙(로캘)의 하나. 시험 DB를 이 규칙으로 만들어 컨테이너가 달라도 정렬 결과가 같게 한다. → data-model §6
- **calcVersion** — 일정 계산 결과에 붙는 번호. 프로젝트 변경 이벤트 수라서, 무엇이든 바뀌면 커진다. 화면이 낡은 계산을 알아채는 데 쓴다. → contracts §4.2
- **canary(검사 표식)** — 누출 시험에만 넣는 가짜 비밀값. 로그·응답·파일에 같은 값이 남으면 시험이 실패한다. → plan/security-review.md
- **catalog (DB 카탈로그)** — DB가 자기 테이블·열·제약 정보를 담아 두는 시스템 목록. SQL 계약을 임시 DB에 적용한 뒤 이것을 읽어 구조를 뽑는다.
- **`causeCandidates`** — 야간 점검 실패의 원인 후보 커밋 목록. 서버가 병합 기록으로 커밋을 Task에 잇는다. → contracts §3.6-2
- **cgroup** — 리눅스가 프로세스 묶음의 CPU·메모리 사용을 재고 제한하는 기능. → architecture §5
- **`cgroup.kill`** — cgroup 안의 모든 프로세스를 커널이 한 번에 끝내게 하는 파일. 1을 쓰면 계정과 상관없이 그 묶음이 모두 끝난다. → architecture §5 `exec`
- **CHECK 제약** — 행을 쓸 때 값이 조건을 만족하는지 DB가 검사하는 제약. 예: `lo<=est<=hi`.
- **child logger(자식 로거)** — 기존 로그 도구에 고정 필드를 붙인 기록 도구. 고정 필드도 비밀값 검사에 포함한다. → plan/security-review.md
- **checkout** — git 저장소의 특정 커밋 내용을 작업 폴더에 꺼내 놓은 것.
- **Chromium** — Chrome의 오픈소스 브라우저. 보고서 HTML을 PDF로 인쇄하는 데 쓴다.
- **CI** — 빌드·테스트를 자동으로 돌리는 과정. 이 프로젝트에서는 ①~④ 4단계. → architecture §5
- **`ci_merge_facts`** — 병합 SHA마다 처음 보고된 tree·부모를 남기는 표. 첫 기록은 바꿀 수 없다. → data-model §2.8
- **ciphertext** — 암호화된 값(암호문). 키 없이는 원래 값을 알 수 없다.
- **claim** — Runner가 job을 「제가 하겠습니다」 하고 예약하는 요청. 예약만 하고 시도는 만들지 않는다. → contracts §3.2
- **returnJob** — 시작 전 자원 부족으로 같은 job을 서버 대기열에 반환하는 요청. 논리 잠금과 현재 fence는 유지한다. 다음 claim은 새 fence를 받는다. → contracts §3.4
- **mergeCommits** — 병합할 Task 커밋과 각 부모의 목록. main의 조상은 뺀다. 서버가 중간 커밋을 원인 Task에 연결하는 근거다. → data-model §3.5
- **classic 토큰** — 권한 범위(scope)를 큰 단위로 고르는 예전 방식의 GitHub 개인 토큰. 응답의 `x-oauth-scopes` 헤더로 권한을 알 수 있다. → contracts §3.1
- **CLI** — 명령줄에서 쓰는 프로그램. 여기서는 주로 Codex CLI·Claude Code CLI.
- **clone** — 원격 git 저장소를 내 PC로 통째로 복사해 오는 것.
- **CODEOWNERS** — GitHub에서 특정 경로를 바꿀 때 지정된 사람의 검토를 요구하는 설정. → contracts §4.1
- **commit / push** — commit은 변경을 git 기록에 남기는 것, push는 그 기록을 원격 저장소(GitHub)에 올리는 것.
- **commit status / status context** — GitHub 커밋에 붙이는 검사 결과(성공·실패). context는 그 검사의 이름(예: `agentwbs/int`)이다.
- **compose secrets** — docker compose가 호스트의 파일을 컨테이너 안 `/run/secrets/<이름>`에 붙여 주는 기능. 비밀값이 구성 정보(`docker inspect`)에 남지 않는다. 운영 DB 비밀번호와 `AWBS_SECRET_KEY`를 이렇게 넘긴다. → docs/ops/operations.md §3
- **controller (cgroup controller)** — cgroup에서 CPU·메모리·프로세스 수 같은 자원을 하나씩 재고 제한하는 기능.
- **coordinator** — owner와 작업자 사이에서 일을 나누고 전달하는 조정자. → open-questions §0
- **CP (Change Proposal, 변경 제안)** — Task를 추가·수정·취소·분할하자는 제안. 미리보기 후 승인·반영한다. → data-model §3.6
- **cp_auto** — 일정 정책의 「Agent가 낸 변경 제안을 자동 처리할지」 설정. 켜져 있으면 보류 사유가 없는 제안은 바로 반영되고, 있으면 `held`가 된다. → contracts §2.1, data-model §2.7
- **CPU** — 컴퓨터의 계산 장치. cores는 그 안의 코어 수.
- **crash** — 프로그램이 예고 없이 비정상 종료되는 것.
- **CRUD** — Create·Read·Update·Delete. 데이터를 만들고 읽고 고치고 지우는 기본 기능.
- **CSP** — 브라우저가 실행할 수 있는 스크립트 출처를 제한하는 보안 헤더. → architecture §4
- **CSRF** — 다른 사이트가 몰래 사용자 대신 요청을 보내는 공격. `X-CSRF-Token`으로 막는다. → architecture §4
- **current_user_can_bypass** — GitHub ruleset 조회 응답의 필드. 지금 요청한 사용자가 그 규칙을 우회할 수 있는지를 `always`·`pull_requests_only`·`never`·`exempt`로 알려 준다. 연결 확인은 `never`만 허용한다. → contracts §3.1
- **cursor (커서)** — 「어디까지 읽었는지」를 나타내는 값. 목록 페이지나 변경 이벤트에서 쓴다. → contracts §7
- **D-xx (해석 결정)** — 가이드가 애매하거나 서로 부딪치는 곳을 이 문서가 정한 결정 번호. → architecture §7
- **demo seed** — 테스트·화면 검증 전용 기본 데이터. 운영 DB에는 넣지 않는다. → data-model §6
- **dedup_key** — 같은 원인으로 job이 두 번 만들어지지 않게 하는 unique 키. 서비스가 원인 시도와 회차로 만든다. → data-model §2.5
- **deploy key** — GitHub 저장소 하나에 붙이는 SSH 인증 키. 이 프로젝트는 시스템 커밋(최초 생성·초기화 되돌림)에만 시스템 deploy key 하나를 쓰고, 다른 deploy key가 있으면 쓰기를 멈춘다. → contracts §3.1·§6, open-questions §0 아이템 10
- **DFS** — 깊이 우선 탐색. 선행 관계를 한 길로 끝까지 따라가 보며 순환(같은 Task로 되돌아옴)을 찾는다.
- **diff** — 두 내용의 차이. CP 미리보기의 `diff`는 바뀌는 필드 목록이다.
- **digest** — 컨테이너 이미지의 고유 지문. 같은 digest면 정확히 같은 이미지다. → architecture §3.2
- **docker / docker compose** — docker는 프로그램을 컨테이너(격리된 실행 상자)로 돌리는 도구, docker compose는 여러 컨테이너를 `compose.yaml` 하나로 함께 띄우는 도구.
- **Dockerfile** — 컨테이너 이미지를 어떻게 만들지 적은 설명서 파일.
- **drift** — 두 사본(예: 문서와 openapi.json, 계약과 코드)이 서로 어긋난 상태. → contracts 머리말, data-model §2.8
- **Drizzle ORM / drizzle-kit** — TypeScript 코드로 DB 테이블을 정의하고 쿼리하는 라이브러리. drizzle-kit은 그 정의에서 마이그레이션 SQL을 만드는 도구.
- **DTO** — 요청·응답으로 주고받는 데이터 모양. → architecture §3.3
- **dubious ownership (git)** — 저장소 폴더의 소유자가 지금 git을 돌리는 계정과 다를 때 git이 그 저장소를 거부하는 보호 동작. 작업 폴더는 Runner 계정이 만들어 넘기므로 Agent 계정 git은 그 폴더 하나만 `safe.directory`로 허용한다. → agent-runner/docs/isolation.md
- **E2E** — 화면부터 서버·DB까지 실제처럼 이어서 하는 끝-끝 테스트.
- **Effort** — Agent가 얼마나 깊이 생각할지 정하는 단계. 공통 1~5로 맞춘다. → open-questions §0.2
- **embed (폰트 embed)** — PDF 안에 글꼴 파일을 함께 넣어 어느 PC에서 열어도 같게 보이게 하는 것.
- **Endpoint** — API의 경로 하나(예: `GET /api/tasks/:taskKey`).
- **enforcement (ruleset)** — GitHub ruleset의 적용 상태. `active`여야 실제로 막는다. 연결 확인은 main 보호 ruleset이 모두 `active`인지 본다. → contracts §3.1
- **enum** — 정해진 값 중 하나만 허용하는 DB 타입. → data-model §1
- **env (환경 변수)** — 환경 변수. 프로그램이 시작할 때 받는 이름=값 설정. `.env` 파일에 모아 둔다.
- **epoch** — 프로젝트 세대 번호. 초기화할 때마다 1 오르며, 옛 세대의 요청이 새 프로젝트를 건드리지 못하게 한다. → contracts §1, data-model §5.1
- **Esc / J/K** — 키보드 단축키. J/K와 ↑↓는 목록 위아래 이동, Esc는 닫기.
- **escape (JSON)** — 따옴표·줄바꿈 같은 특수 문자를 JSON 문자열 안에 적는 방식(예: 줄바꿈을 `\n`으로 적음). `subjectHash`는 JavaScript `JSON.stringify` 규칙을 따른다. → data-model §2.3-1
- **ETag** — 응답 내용의 버전 표시. 같으면 다시 받을 필요가 없다.
- **Evidence (검증 증거)** — 검증 결과를 뒷받침하는 파일(로그·스크린샷 등). → data-model §2.5
- **exec** — 실행 중인 프로세스를 다른 명령으로 바꿔 실행하는 것. 대기 래퍼가 허가를 받은 뒤 실제 명령으로 바뀐다.
- **ext4** — 리눅스 기본 파일 시스템. WSL에서 Windows 쪽 디스크보다 빠르고 권한·링크가 정확하다.
- **`failScope`** — 실패한 ① 결과의 원인 쪽. `baseline`은 기준(main) 쪽 문제라 Task 잘못이 아니고, `task`는 Task 코드 문제다. → contracts §3.5·§3.6-2
- **fake** — 실제 외부 서비스(Claude·Codex·GitHub·SMTP 등) 대신 쓰는 가짜 구현. 돈이 들지 않고 결과가 일정해 테스트에 쓴다. → milestones §1
- **fake BotAPI** — 시험에서 실제 Telegram 대신 요청을 받아 적는 작은 HTTP 서버. → milestones M6 통합
- **fast-forward / FF push** — 병합 커밋 없이 main 가리키는 위치만 앞으로 옮기는 것. 이 계획은 일반 PR 병합에 쓰지 않는다.
- **Fastify** — Node.js용 웹 서버 프레임워크. API 서버를 만든다. inject는 실제 네트워크 없이 요청을 보내 보는 테스트 기능.
- **FE** — 프론트엔드(Front End). 브라우저에서 도는 화면 쪽 코드.
- **fence** — 낡은 Runner의 보고를 막는 번호표. job을 새로 임대할 때마다 바뀌고, 일반 보고는 낡은 fence면 409 LEASE_LOST로 거절한다. 원래 job·host·boot·process group이 맞는 보유 해제 보고(`release`)는 예외다. → contracts §3.2
- **fine-grained 토큰** — 접근할 저장소와 권한을 좁게 정할 수 있는 GitHub 개인 토큰.
  - GitHub 응답만으로는 쓰기 권한을 알 수 없어, 연결 확인은 쓰기 권한을 「미확인」으로 보고하고 첫 실제 쓰기에서 확정한다. → contracts §3.1
- **fixture** — 테스트에 쓰는 고정 데이터.
- **FK / PK** — FK(외래 키)는 다른 테이블 행을 가리키는 열, PK(기본 키)는 행을 구분하는 고유 번호. → data-model §1
- **flock** — Linux의 파일 잠금 명령. 강제 종료로 남은 잠금을 안전하게 회수할 때 쓴다. 없으면 준비 점검 `repo`가 warn이다. → architecture §5
- **FOR UPDATE / FOR SHARE / SKIP LOCKED** — PostgreSQL 행 잠금. `FOR UPDATE`는 고치려고 독점 잠금, `FOR SHARE`는 읽는 동안 바뀌지 않게 공유 잠금, `SKIP LOCKED`는 이미 잠긴 행을 건너뜀.
- **FS / SS** — 의존성 종류. FS(Finish-to-Start)는 「선행이 끝나야 후속 시작」, SS(Start-to-Start)는 「선행이 시작되면 후속 시작 가능」. → data-model §2.3, §3.1
- **fsync** — 파일 내용을 디스크에 실제로 다 썼는지 확인하는 시스템 호출. 정전·종료에도 기록이 남게 한다.
- **G** — 가이드. `prototype/docs/Agent-WBS-설계의도-및-구현가이드.md`. 원본끼리 충돌하면 G가 우선한다.
- **G L123 / P L456** — 가이드 123번째 줄, 프로토타입 456번째 줄. 출처를 가리키는 표기.
- **Gantt** — Task별 시작·끝을 가로 막대로 그린 일정 차트.
- **Gate** — Task를 완료로 판정하기 전에 모두 통과해야 하는 조건 묶음(5조건). → data-model §3.1
- **gate (owner 결정 gate)** — owner의 답이 있어야 열리는 관문. 답 전에는 fake·잠정 fixture까지만 만든다. → open-questions §1
- **`GATE_UNMET_AFTER_MERGE`** — 병합은 됐지만 그 순간 Gate 조건이 깨진 사건. `MERGE_MISMATCH`와 다른 사건이고, Task는 gate에 머물다가 조건이 다시 충족되면 자동 완료한다. → contracts §3.6-6
- **generation** — PC(host)가 바뀔 때마다 1 오르는 외부 쓰기 권한 세대 번호. → contracts §3.4
- **GET / POST / PUT / PATCH / DELETE** — HTTP 요청의 종류. GET 조회, POST 생성·실행, PUT 통째로 교체, PATCH 일부 수정, DELETE 삭제.
- **gh** — GitHub 공식 CLI.
- **Git / GitHub** — git은 코드 변경 기록 도구, GitHub는 git 저장소를 올려 두고 PR·검사·병합을 하는 서비스.
- **git bundle** — 브랜치의 git 기록을 파일 하나로 묶은 데이터. Runner는 Agent 계정이 만든 bundle만 받아 자기 bare 저장소에서 검사(verify) 뒤 가져온다. Agent 폴더의 `.git`을 직접 읽지 않기 위해서다. → agent-runner/src/git/README.md
- **git-lfs** — 큰 파일을 git 밖에 저장하는 git 확장.
- **grep** — 파일에서 문자열을 찾는 명령. 예: 토큰이 로그에 남았는지 찾기.
- **hash** — 내용을 짧은 문자열로 줄인 지문. 내용이 조금만 바뀌어도 달라진다. → data-model §2.3-1
- **`headSync` / `headSync.chain`** — H→H′가 「QA한 H + main의 충돌 없는 병합」임을 보이는 증거. 여러 번 동기화했으면 단계마다 이은 사슬(chain)로 보낸다. → contracts §4.1 코드 근거 고정 3-2
- **HKDF-SHA256** — 공유 비밀에서 실제 암호 키를 뽑아내는 표준 계산 방식. 봉인 형식 v1이 쓴다. → contracts §6.1
- **headSha** — 브랜치 맨 끝 커밋의 고유 번호(SHA). 검증한 코드를 고정하는 데 쓴다. → contracts §4.1
- **heartbeat** — Runner가 「아직 살아 있다」고 60초마다 보내는 신호. 3회 누락이면 끊긴 것으로 본다. → contracts §3.1
- **hold (보유)** — job이 차지한 물리 슬롯과 논리 잠금의 기록. → data-model §2.5-1
- **hook** — 프로그램이 어떤 일이 생길 때 자동으로 불러 주는 사용자 스크립트. 이 계획은 CLI hook을 쓰지 않는다.
- **host** — Runner가 도는 PC.
- **HTML** — 웹 페이지 문서 형식.
- **HTTP 상태 코드** — 응답 결과를 나타내는 숫자. 2xx 성공(200, 201, 202 접수, 204 본문 없음), 4xx 요청 문제(400 형식, 401 인증, 403 권한, 404 없음, 409 상태 충돌, 429 너무 많음), 5xx 서버 문제.
- **HttpOnly / SameSite=Strict** — 쿠키를 스크립트가 읽지 못하게 하고, 다른 사이트에서 온 요청에는 붙지 않게 하는 쿠키 설정. → architecture §4
- **I/O** — 입출력(Input/Output). 파일·DB·네트워크를 읽고 쓰는 일.
- **inject (Fastify inject)** — 실제 네트워크 없이 서버에 요청을 넣어 응답을 받아 보는 Fastify 테스트 기능.
- **inputRecheck** — Runner 정책(`GET /runner/policy`)의 입력 확인 다시 시도 번호. 팀장이 이력 재작성 경고에서 복구 확인을 누를 때마다 1 오른다. → contracts §3.1
- **ISO 8601** — 날짜·시각을 `2026-11-25T09:00:00Z`처럼 적는 국제 표준 형식.
- **jitter** — 재시도 대기 시간을 조금씩 흩뜨려 요청이 한꺼번에 몰리지 않게 하는 것. → contracts §1.2
- **job (작업)** — Runner에게 맡기는 일 한 건. 종류는 contracts §3.2의 표에 있다.
- **journal (마이그레이션 목록)** — 마이그레이션의 적용 순서와 시각을 적은 파일(`meta/_journal.json`). 항목마다 idx(자리)·tag(파일 이름)·when(적용 순서 시각)이 있다. → data-model §6
- **JSON / jsonb** — JSON은 `{"key": 값}` 모양의 텍스트 데이터 형식, jsonb는 PostgreSQL이 JSON을 저장하는 열 타입.
- **JSON Pointer** — JSON 안의 중첩 필드를 가리키는 고정 주소(예: `/paths/~1api/get`). 주소 안의 `~1`은 `/`, `~0`은 `~`를 뜻한다.
- **JSON Schema** — JSON 데이터의 모양을 정의하고 검사하는 형식. → contracts §5
- **keyId** — Runner가 등록한 봉인용 공개키의 이름표. 서버가 공개키의 SHA-256 지문으로 계산한다. credential 조회 때 이 값으로 키를 고른다. → contracts §3.1
- **Kafka / Redis** — Kafka는 메시지 브로커(프로그램 사이 메시지를 중계·보관하는 서버), Redis는 메모리 기반 저장소. 이 제품 런타임에는 쓰지 않는다(D-02).
- **kill -9** — 프로세스를 정리할 틈 없이 즉시 강제 종료하는 명령. 장애 시험에 쓴다.
- **KST** — 한국 표준시(Asia/Seoul).
- **LAN** — 같은 사무실·집 안의 네트워크. LAN 접속은 비밀번호로 로그인한다. → architecture §4
- **leader (프로세스 그룹 대표)** — 프로세스 그룹을 처음 만든 프로세스. 그룹을 정리할 때 이 프로세스의 pid·시작 시각을 대조해 엉뚱한 그룹을 죽이지 않는다. → architecture §4 「외부 쓰기 관문」
- **lease (임대)** — 「이 job은 정해진 시간 동안 이 Runner가 맡는다」는 표시. 60초, 20초마다 renew. 만료돼도 자원 해제는 아니다. → contracts §3.2
- **linger** — 로그인하지 않아도 그 계정의 사용자 systemd를 계속 띄워 두는 설정(`loginctl enable-linger <계정>`). Runner와 cgroup scope가 재시작 뒤에도 뜨려면 필요하다. → architecture §6.3
- **Link 헤더 / pagination(페이지 나눔)** — 목록이 길면 GitHub가 여러 쪽으로 나눠 주고, `Link` 응답 헤더에 다음 쪽 주소를 적는다. 이 계획은 그 주소를 따라가지 않고 같은 경로의 `page` 번호를 올려 읽는다. → contracts §6
- **lint / typecheck** — lint는 코드 규칙 위반을 자동으로 찾는 검사, typecheck는 TypeScript 타입 오류 검사.
- **liveInject / live_inject** — 실행 중인 작업에 메시지를 즉시 넣을지 나타내는 설정 필드. Q-07(owner 2026-11-27 아이템 18)에 따라 현재는 켤 수 없다. 기존 `true`도 `false`로 취급한다.
- **lockfile** — 설치한 패키지의 정확한 버전을 고정해 두는 파일. → architecture §3.2
- **loopback** — 같은 PC 안에서 자기 자신에게 접속하는 연결(`127.0.0.1`). 1회용 링크 로그인은 loopback에서만 된다. → architecture §4
- **LTS** — Long Term Support. 오래 보안 수정을 받는 안정 버전.
- **M0~M8 / Mx-yy** — 마일스톤과 작업 ID. 예: `M2-05`는 2단계의 5번째 작업. → milestones §1
- **manifest** — zip 같은 묶음 안에 어떤 파일이 들었는지 적은 목록 파일.
- **Mantine** — 버튼·표·입력창 같은 React 화면 부품 모음.
- **merge / merge-base** — merge는 두 브랜치를 합치는 것, merge-base는 두 브랜치가 갈라진 공통 조상 커밋.
- **`MERGE_MISMATCH`** — 실제 병합의 부모·tree가 저장된 근거와 다를 때의 409 오류 코드. 서버는 실제 병합 SHA와 경고를 먼저 남기고 Task를 보류한다. → contracts §3.6-6
- **Mermaid** — 텍스트로 흐름도·순서도를 그리는 문법. GitHub가 그림으로 보여 준다.
- **middleware** — 요청이 실제 처리 코드에 닿기 전에 공통으로 거치는 코드(인증·epoch 검사 등).
- **migration (마이그레이션)** — DB 테이블 구조를 바꾸는 SQL 파일. 순서대로 한 번씩 적용한다.
- **MIME** — 메일의 제목·서식 없는 본문·HTML 본문·첨부를 구분하는 표준 형식. → plan/security-review.md
- **`MigrationGapError`** — 적용 누락 검사에서 journal의 마이그레이션이 DB 기록에 빠져 있을 때 나는 오류. `db:migrate`가 여기서 멈춘다. → data-model §6
- **Mock** — 가짜 데이터로 움직이는 시안. 프로토타입(P)이 Mock이다. 제품 규칙의 근거로는 G가 우선한다.
- **Multi Format Schema Object** — AsyncAPI에서 메시지 스키마의 종류와 내용을 함께 적는 객체. Runner는 그 안의 JSON Schema만 해석한다(owner Q-14 A).
- **multipart** — 파일을 HTTP로 올릴 때 쓰는 요청 형식. → contracts §3.1
- **mutation test(변이 검사)** — 안전장치를 잠깐 제거한 뒤 시험이 실제로 실패하는지 확인하는 방법. 확인 뒤 원래 코드를 복원한다. → plan/security-review.md
- **Neo4j** — 노드와 관계로 데이터를 저장하는 그래프 데이터베이스.
- **Node.js / pnpm** — Node.js는 서버에서 JavaScript·TypeScript를 실행하는 환경, pnpm은 그 패키지 설치 도구.
- **nodemailer** — Node.js에서 SMTP로 메일을 보내는 라이브러리.
- **NOLOGIN** — 그 DB 역할로는 직접 로그인할 수 없다는 표시. 표 소유자 역할에 붙여 앱이 소유자 권한을 쓰지 못하게 한다. → data-model §6.1
- **nginx** — 웹 서버 프로그램. 운영 구성에서 화면 파일을 보내고 `/api`·`/health` 요청을 api로 넘긴다. → docs/ops/operations.md §1.3
- **nonce** — 암호화할 때마다 새로 만드는 한 번용 난수. 같은 키로도 결과가 매번 달라진다.
- **nosniff** — `X-Content-Type-Options: nosniff`. 브라우저가 파일 형식을 멋대로 추측해 실행하지 못하게 한다.
- **NOT NULL / NULL** — NULL은 「값이 없음」이다. NOT NULL 열은 값을 반드시 넣어야 한다.
- **NULLS NOT DISTINCT** — unique 검사에서 NULL끼리도 같은 값으로 보는 옵션. 보통은 NULL끼리 서로 다르다고 봐서 중복이 통과한다. → data-model §2.8 `idempotency_keys`
- **OpenAPI** — REST API의 경로·요청·응답을 기계가 읽게 적는 표준 문서 형식. 두 시스템이 공유하는 유일한 것. → architecture §1
- **orchestration** — 여러 Agent·단계를 정해진 순서로 엮어 실행하는 것.
- **Origin** — 브라우저 주소의 「프로토콜·호스트·포트」 묶음(예: `http://127.0.0.1:5173`). 서버는 변경 요청의 Origin이 `AWBS_ORIGIN`과 같아야 받는다. → architecture §4
- **ORM** — Object-Relational Mapping. SQL 대신 코드 객체로 DB를 다루게 해 주는 도구.
- **orphaned** — host가 바뀌어 효력만 없앤 옛 잠금 상태(감사용). → data-model §2.5-1
- **OS** — 운영체제(Operating System). 여기서는 리눅스(WSL2).
- **outbox** — 보낼 것을 먼저 저장해 두고 나중에 보내는 대기함. 끊겨도 다시 보낼 수 있다. → architecture §2
- **overflow-wrap: anywhere** — 한 줄에 다 들어가지 않는 긴 단어만 줄 끝에서 끊는 CSS 설정. 보통 글의 줄바꿈은 바꾸지 않는다. 보고서 PDF에서 긴 글이 칸 밖으로 넘치지 않게 쓴다.
- **owner** — 이 프로젝트의 최종 결정권자. → open-questions
- **P** — 프로토타입. `prototype/uiux/Main.dc.html`.
- **p95** — 측정값을 작은 순으로 늘어놓았을 때 95% 지점의 값. 「거의 모든 요청이 이 시간 안에 끝난다」는 뜻으로 응답 시간 기준에 쓴다.
  - M8-02에서는 동작마다 20번 재고 19번째 값으로 판정한다. 한 번의 빠른 응답만으로 통과시키지 않기 위해서다.
- **parser** — 글로 된 파일(YAML·OpenAPI 등)을 읽어 프로그램이 다룰 구조로 바꾸는 코드.
- **payload** — 요청이나 job에 실어 보내는 실제 내용.
- **PC** — 개인용 컴퓨터. 이 문서에서는 Runner와 Agent가 도는 개발 PC(host)를 뜻한다.
- **PDF** — 인쇄·배포용 문서 파일 형식.
- **pdfjs-dist** — PDF 파일을 열어 글자·위치를 꺼내는 라이브러리. 시험이 보고서 PDF의 글자·쪽 크기·글꼴을 확인할 때 쓴다(제품 코드에는 없음). → apps/api/src/pdf/README.md
- **pg_dump / pg_restore** — PostgreSQL DB를 파일 하나로 뜨는 명령과, 그 파일을 DB로 되살리는 명령. 배포 전 백업에 쓴다. → docs/ops/operations.md §7
- **pg_resetwal** — 멈춘 PostgreSQL 서버의 내부 기록을 고치는 관리 명령. 복원할 때 트랜잭션 번호의 epoch를 백업 쪽보다 크게 올리는 데만 쓴다. → docs/ops/operations.md §7.2
- **pgid (process group ID)** — 프로세스 그룹 번호. Agent가 띄운 자식 프로세스까지 한꺼번에 관리·종료하는 데 쓴다. → contracts §3.4
- **pendingNext** — 메시지를 다음 실행 시작 때 전달하려고 보관했는지 나타내는 필드. 화면의 「다음 실행 대기」가 이 뜻이다.
- **PID** — 프로세스 번호(Process ID). PID 1은 시스템이 처음 띄운 프로세스.
- **pino** — Node.js 로그 라이브러리. redact로 비밀값을 가린다.
- **placeModel / modelRanks** — 설정 순서에 없는 새 모델의 자리를 정하는 함수와, 순서를 rank 숫자로 바꾸는 함수(shared). → data-model §6.2
- **Planning (Planning Agent)** — 계획(WBS 초안·추정·분할·판단)을 세우는 Agent 작업. Claude·Codex가 각자 분석하고 교차 검토한다. → architecture §5
- **Playwright** — 브라우저를 코드로 조작해 화면 테스트·PDF 생성을 하는 도구.
- **polling** — 일정 간격으로 「바뀐 것 있나요?」 하고 묻는 방식. Runner→WBS, 화면→서버 모두 polling이다. → architecture §1, §2.1
- **PostgreSQL** — 표(테이블)로 데이터를 저장하는 관계형 데이터베이스.
- **PR (Pull Request)** — GitHub에서 브랜치 변경을 main에 합쳐 달라는 요청. Task당 1개. → contracts §6
- **prefers-reduced-motion** — 사용자가 OS에서 「움직임 줄이기」를 켰는지 알려 주는 브라우저 설정. 켜져 있으면 애니메이션을 줄인다.
- **Pretendard GOV** — 화면과 PDF에 쓰는 한글 글꼴. 화면은 가변 글꼴 파일을, PDF는 같은 판(1.3.9)의 고정 굵기 글꼴 파일을 쓴다. 왜: 가변 글꼴은 PDF에서 Type3 그림 글자가 되어 글꼴 파일이 들어가지 않는다.
- **`pr` / `prHead`** — Runner가 연 PR의 번호와 그 PR의 head 브랜치 이름. 서버는 `prHead`가 그 시도의 브랜치와 같을 때만 받는다. → contracts §3.6-1
- **principal** — 요청한 주체(`lead` 팀장 또는 `runner`). → architecture §4
- **private (저장소)** — 허가된 사람만 볼 수 있는 GitHub 저장소 공개 설정.
- **proof (해제 증거)** — 보유를 풀어도 된다는 증거. `no_process`·`group_empty`·`boot_changed` 세 가지. → contracts §3.4
- **prune** — 쓰지 않는 컨테이너·볼륨 등을 한꺼번에 지우는 docker 명령. 다른 프로젝트 것까지 지울 수 있어 쓰지 않는다.
- **Q-xx** — owner에게 묻는 질문 번호. 답이 나온 것은 open-questions §0, 남은 것은 §2. → open-questions
- **QA** — 개발 결과를 다른 Agent가 검증하는 단계. 결과는 PASS·FAIL·BLOCKED. → data-model §3.1
- **R1~R6, P1~P3** — 리뷰 지적 번호와 심각도(P1이 가장 무겁다). → milestones §6
- **rank (모델 순서)** — 모델의 등급 순서 숫자. 클수록 위 등급이다. 서버 설정값(`rankOrder`)에서 계산하며 Runner 보고에는 싣지 않는다. → contracts §2.1, data-model §6.2
- **rankOrder** — Agent별 모델 ID 목록으로 된 모델 순서 설정. 아래 등급부터 적고, 팀장이 바꿀 수 있다(owner 2026-11-26 아이템 8). → contracts §2.1
- **React / React Router** — React는 화면을 부품(컴포넌트) 단위로 만드는 라이브러리, React Router는 URL에 맞는 화면을 보여 주는 라이브러리.
- **readiness (준비 상태)** — Runner가 일할 준비가 됐는지(CLI·git·디스크 등) 점검한 결과. → architecture §5
- **realpath / symlink** — symlink는 다른 파일을 가리키는 바로가기 파일, realpath는 그런 링크를 모두 따라간 실제 경로. 저장소 밖으로 빠져나가는지 검사한다.
- **reconcile (대조)** — 끊긴 외부 작업이 실제로 어디까지 됐는지 GitHub 등을 조회해 확인하는 것. → contracts §3.4
- **`record_no` / `run_no` / `queue_no` (저장 순번)** — 행을 저장한 순서대로 늘어나는 번호. 벽시계와 달리 뒤로 가지 않아 「최신 하나」를 고르는 데 쓴다. → data-model §1
- **redact / 마스킹** — 로그에서 토큰·비밀번호를 가리는 것. → architecture §4
- **registry (패키지 registry)** — 패키지(CLI 등)를 올려 두고 내려받는 서버. 테스트에서는 fake registry를 쓴다(M4-05). 메시지 스키마용 레지스트리는 「스키마 레지스트리」 항목 참고.
- **rename (원자적 rename)** — 새 파일을 다 쓴 뒤 이름만 바꿔 끼우는 방법. 중간에 죽어도 반쯤 쓴 파일이 남지 않는다.
- **renew** — lease를 연장하는 요청. → contracts §3.2
- **repositoryIdFor** — 저장소 주소를 정규화해 SHA-256을 구하고, 그 앞 16자리 앞에 `r-`를 붙인 로컬 저장소 이름(예: `r-0ef6f111ef40232e`). Runner가 정리 명령의 `repoUrl`로 로컬 저장소를 찾을 때 쓴다. → contracts §3.2
- **REST** — HTTP의 GET·POST·PUT·PATCH·DELETE 요청으로 자원(데이터)을 주고받는 API 방식.
- **Retry-After** — 서버가 「몇 초 뒤 다시 보내라」고 알려 주는 응답 헤더. 429와 함께 온다.
- **RFC 5987 (`filename*`)** — 내려받을 파일 이름에 한글 같은 글자를 적는 방식. 예: `filename*=UTF-8''RPT-W-261026_%ED%8C%80…pdf`. 한글을 못 읽는 프로그램을 위해 `filename="RPT-W-261026.pdf"`도 함께 보낸다. → apps/api/src/pdf/routes.ts
- **rework / reverify** — 재작업 시도와, 재작업 후의 재검증 시도. → data-model §3.1
- **Route / Service / Repository** — API 서버 코드의 세 층. Route는 요청 모양 검증, Service는 업무 규칙, Repository는 DB 쿼리만 맡는다.
- **RP** — 재조정(replan) 기록의 표시 ID(예: `RP-004`).
- **ruleset (GitHub)** — GitHub에서 브랜치 보호 규칙을 묶어 적용하는 기능. 현재 요금제의 private 저장소에서는 API가 403이다(Q-09).
- **run-grade** — 이번 시도에 쓸 모델·Effort를 서버에 묻는 API. → contracts §3.1
- **`runner:` (단계 이름 접두어)** — Runner가 직접 붙이는 CI 단계 이름의 앞머리(예: `runner:worktree`). `pipeline.yaml`의 단계 이름과 섞이지 않게 한다. → contracts §3.6-2
- **safe.directory (git 설정)** — 소유자가 다른 저장소도 git이 열도록 허용하는 설정. 명령줄·전역 설정에서만 읽고 저장소 설정(`.git/config`)에서는 읽지 않는다. 그래서 Agent가 저장소 설정으로 넓힐 수 없다.
- **sandbox** — 프로그램이 파일·네트워크를 건드릴 수 있는 범위를 제한한 실행 환경.
- **schema (스키마)** — 데이터의 모양(필드·타입·제약)을 정의한 것. DB schema, API schema, JSON Schema 등.
- **scope (systemd scope)** — systemd가 프로세스 묶음을 하나로 관리하는 단위. cgroup을 만든다. → open-questions §3
- **scrypt** — 비밀번호를 되돌릴 수 없게 바꾸는 계산 방식. 일부러 느려서 무차별 대입을 어렵게 한다.
- **search_path (검색 경로)** — 이름만 쓴 표·함수를 어느 스키마에서 찾을지 정한 목록. 높은 권한 함수는 이것을 고정해 가짜 함수가 끼어들지 못하게 한다. → data-model §6.1
- **SECURITY DEFINER** — 부르는 사람이 아니라 함수를 만든 역할의 권한으로 실행되는 DB 함수. 초기화·정리 완료처럼 앱이 직접 못 하는 일을 정해진 방법으로만 하게 한다. → data-model §6.1
- **sealed (봉인 값)** — GitHub 토큰을 Runner 공개키로 잠근 값. 그 Runner의 개인키로만 열 수 있다. 형식은 「봉인 형식 v1」이다. → contracts §6.1
- **serialization(로그)** — 객체를 로그 한 줄의 문자열로 바꾸는 과정. 로그를 내보내기 직전에 비밀값을 가린다. → plan/security-review.md
- **seed** — 빈 DB에 처음 넣는 기본 데이터. `system`과 `demo` 두 가지. → data-model §6
- **semaphore** — 동시에 정해진 개수만 실행되게 막는 번호표 장치. → architecture §5
- **`serviceDown` (서비스 없음)** — ④ 배포 확인과 자동 복구까지 실패했을 때 보내는 높은 우선순위 알림. 알림 규칙과 무관하게, 전체 알림이 켜져 있으면 보낸다. → data-model §3.7
- **SHA** — git 커밋의 고유 번호(hash).
- **SHA-256 / sha256** — 내용으로 256비트 지문(hash)을 만드는 방식. 토큰 저장·파일 무결성 확인에 쓴다.
- **shell** — 명령줄 문자열을 해석해 실행하는 프로그램(bash 등). 문자열을 이어 붙여 명령을 만들면 입력값이 명령으로 해석될 위험이 있다.
- **shrink-to-fit** — 쪽보다 넓은 문서를 인쇄할 때 브라우저가 쪽 폭에 맞춰 줄여 찍는 동작. 줄면 글자도 작아진다.
- **SIGKILL** — 프로세스에 정리할 기회를 주지 않고 즉시 끝내는 운영체제 신호. Runner가 갑자기 죽어도 남은 자손과 보유를 안전하게 정리하는지 시험할 때 쓴다. → milestones M8-02
- **slice (systemd slice)** — systemd가 프로세스 묶음에 CPU·메모리를 나눠 주는 상위 단위. 사용자 slice 아래에 세션 scope를 만든다.
- **slot (물리 슬롯)** — PC의 CPU·메모리 같은 실행 자리. 프로그램 실행에 쓸 PC 자리다. 실행 전 예약(`reserved`)과 종료 미확인 보유(`unconfirmed`)도 용량에 포함한다. → data-model §2.5-1
- **SMTP** — 메일을 보내는 표준 방식(메일 서버). → contracts §4.4
- **socket 주소** — 실제로 연결해 온 상대의 IP 주소. 요청 헤더와 달리 꾸밀 수 없다.
- **soft delete** — 행을 지우지 않고 「지움」 표시(`deleted_at`)만 하는 방식. → data-model §1
- **SQL** — 관계형 데이터베이스에 데이터를 묻고 고치는 언어.
- **SQLSTATE (DB 오류 코드)** — DB가 오류마다 붙이는 다섯 글자 코드. 이 문서에 나오는 것: `23514` 제약 위반, `40P01` 교착으로 취소됨, `AW001` 낡은 epoch, `AW002` 정리 증거 불일치(`AW…`는 이 프로젝트가 정한 코드). → data-model §5·§5.1
- **SSE / WebSocket** — 서버가 화면으로 바로 밀어 주는 실시간 통신 방식. 이 제품 런타임에는 쓰지 않는다(D-02). → architecture §2.1
- **SSH / SSH agent** — 원격 PC에 암호화된 연결로 접속하는 방식. SSH agent는 그 키를 메모리에 들고 있는 프로그램.
- **stacked PR / merge queue** — stacked PR은 PR 위에 PR을 쌓는 방식, GitHub merge queue는 GitHub가 병합 순서를 관리하는 기능. 이 계획은 둘 다 쓰지 않는다.
- **strict (up-to-date 보호)** — main 최신을 포함하고 필수 검사를 통과해야 병합을 허락하는 GitHub 브랜치 보호 설정. → contracts §4.1
- **submodule** — git 저장소 안에 다른 저장소를 끼워 넣은 것. 입력 자료에서는 따라가지 않는다.
- **sudo** — 관리자 권한으로 명령을 실행하는 리눅스 명령.
- **sudoers** — 누가 어떤 명령을 다른 계정으로 실행해도 되는지 적은 리눅스 설정 파일. Runner가 Agent 계정으로 실행할 수 있는 것은 래퍼 하나뿐이다. → architecture §4
- **SVG** — 확대해도 깨지지 않는 벡터 그림 파일 형식.
- **systemd** — 리눅스에서 서비스(상주 프로그램)를 띄우고 관리하는 시스템 프로그램. Runner는 사용자 systemd 서비스로 돈다.
- **tabular-nums** — 숫자마다 폭을 같게 해 표의 숫자 열이 가지런해지는 글꼴 설정.
- **TanStack Query** — 화면에서 서버 데이터를 불러오고 캐시·다시 불러오기를 관리하는 라이브러리.
- **@tanstack/react-virtual** — 긴 목록에서 화면에 보이는 행만 그려 빠르게 만드는 가상 스크롤 라이브러리.
- **Task** — WBS에서 일 한 건. ID는 `TASK-` + 숫자 4자리 이상. → data-model §2.3
- **Telegram** — 메신저 서비스. 이 제품은 상태 알림을 Telegram 봇으로 보낸다.
- **telemetry** — Runner의 상태 보고(heartbeat·host·readiness 등). fence 없이 보낸다. → contracts §3.2
- **text/plain** — 서식 없이 글자만 있는 본문 형식. HTML 메일을 못 읽는 프로그램을 위해 함께 넣는다.
- **timeout** — 정해진 시간 안에 응답이 없으면 실패로 보는 것.
- **timestamptz** — PostgreSQL에서 시간대를 반영해 UTC의 한 시점으로 저장하는 타입. 원래 시간대 정보는 보관하지 않는다. UTC로 저장하고 표시할 때 Asia/Seoul로 바꾼다.
- **TOCTOU (Time Of Check To Time Of Use)** — 확인한 뒤 실제로 쓰기 전 사이에 상태가 바뀌는 틈. 같은 사용자 권한에서 생기는 이 틈은 전용 계정 실행으로 막는다. → architecture §4
- **`track_commit_timestamp`** — PostgreSQL이 트랜잭션마다 커밋 시각을 기억하게 하는 서버 설정. 서버를 시작할 때만 바꿀 수 있고, 이 프로젝트는 꼭 켜야 한다. → data-model §6
- **tree (git tree)** — 커밋 시점의 파일·폴더 전체 내용. tree가 같으면 파일 내용이 완전히 같다.
- **treeHash** — 입력 변경 보고의 필드. head 커밋의 `prototype/` 폴더 전체(파일 모드 포함)를 나타내는 git 트리 SHA다. → contracts §3.1 입력 변경 보고
- **trim** — 문자열 앞뒤의 공백을 지우는 처리. `subjectHash` 계산은 trim을 하지 않으므로 앞뒤 공백도 내용 차이다. → data-model §2.3-1
- **TS / TypeScript** — 변수·함수에 타입을 붙여 실수를 미리 잡는 JavaScript. TS로 줄여 쓴다.
- **Type3 (그림 글자)** — PDF 안에 글꼴 파일 대신 글자 모양을 그림처럼 넣는 방식. 글꼴 파일이 들어간 것(폰트 embed)이 아니라서 보고서 PDF에는 쓰지 않는다. 시험이 0개인지 확인한다.
- **TypeBox** — TypeScript로 스키마를 정의해 검증·타입·OpenAPI를 한 번에 만드는 도구. → architecture §3.2
- **typescript-eslint** — TypeScript 코드에 lint 규칙을 적용하는 도구.
- **TZ** — 프로세스의 시간대(time zone) 설정 환경 변수.
- **`unchecked` (대조 안 함)** — 계약과 실제 명세를 대조하지 못한 상태. 「일치」나 「호환」이라는 뜻이 아니다. 해석기가 모르는 것은 늘 이 값으로 둔다. → contracts §2.3 「설계」
- **umask** — 새로 만드는 파일·폴더의 권한에서 미리 빼 둘 권한. `0077`이면 만든 사람만 읽고 쓸 수 있다(파일 0600, 폴더 0700).
- **Unicode 정규화 (NFC/NFD)** — 겉모양이 같은 글자의 서로 다른 문자 표현(예: 완성형 「한」과 자모를 조합한 「한」)을 하나로 맞추는 처리. `subjectHash` 계산은 이것을 하지 않는다. → data-model §2.3-1
- **UTF-16 코드 단위 순서** — JavaScript가 문자열을 기본으로 비교하는 순서. `subjectHash` 계산에서 객체 키와 산출물 이름을 이 순서로 정렬한다. → data-model §2.3-1
- **verified / unverified / missing (GitHub 권한 3상태)** — GitHub 권한 하나의 확인 상태. 확인됨·미확인(추정하지 않음)·부족. 조정자 결정(2026-11-26). → contracts §3.1
- **UI** — 사용자 화면(User Interface).
- **URL** — 웹 주소.
- **UTC** — 세계 표준시. 시각은 UTC로 저장하고 한국 시간으로 보여 준다. → architecture §6.4
- **UTF-8** — 한글을 포함한 모든 문자를 바이트로 저장하는 표준 문자 인코딩.
- **uuid** — 겹치지 않게 만드는 128비트 고유 ID.
- **Vite** — 화면 코드를 개발 중에 바로 보여 주고 배포용으로 묶어 주는 도구.
- **Vitest** — TypeScript 코드의 단위 테스트를 돌리는 도구.
- **warn:manual-reconcile (수동 대조 필요)** — 초기화 정리 결과에 남기는 경고 항목. 시스템이 해석하지 못한 PR 참조가 있어 사람이 직접 확인해야 한다는 뜻이다. 서버가 팀장 알림으로 바꾼다. → contracts §3.2
- **WBS (Work Breakdown Structure)** — 일을 단계·작업 묶음·Task로 쪼갠 구조. 이 제품의 이름이기도 하다.
- **Web shell** — 메뉴·헤더·본문 영역을 갖춘 웹 화면의 뼈대(M0-04). 명령줄의 shell과는 다른 뜻이다.
- **when (journal)** — Drizzle이 「이미 적용했나」를 판단하는 시각 값. DB의 마지막 기록보다 큰 것만 적용한다. 이 프로젝트는 `1795740000000 + 번호`로 정한다. → data-model §6
- **Wizard** — 여러 단계로 나눠 차례로 입력하는 화면. Task 생성 Wizard는 3단계다.
- **word-break: keep-all** — 한글도 띄어쓰기에서만 줄을 바꾸게 하는 CSS 설정. 기본값은 한글 음절 사이 어디서나 줄을 바꾼다(예: 「개/발」). 보고서 PDF의 표 칸에 쓴다.
- **worker** — 보고서·메일·알림·감시 같은 뒷일을 맡는 서버 프로세스. → architecture §2
- **workspace (pnpm workspace)** — 한 저장소 안에 여러 패키지(`apps/web` 등)를 두고 함께 설치·빌드하는 pnpm 기능.
- **worktree** — 같은 git 저장소를 작업마다 따로 꺼내 둔 작업 폴더. Agent는 이 안에서만 일한다. → architecture §1
- **WS** — WebSocket의 줄임말. SSE / WebSocket 항목 참고.
- **WSL** — Windows에서 리눅스를 돌리는 환경. 개발 PC가 WSL2다. → architecture §5
- **X25519** — 두 쪽이 각자 키 쌍을 갖고 상대 공개키와 자기 개인키로 같은 비밀을 만들어 내는 키 교환 방식. 봉인 형식 v1이 쓴다. → contracts §6.1
- **x-input-rules (입력 규칙)** — JSON Schema로 쓸 수 없는 입력 검사(예: 설계 kind 중복 금지 `uniqueDesignKind`)를 OpenAPI에 표시하는 확장 항목. 서버가 형식 검증 뒤 실행하고, 어기면 400 VALIDATION_FAILED다. → contracts §2.1
- **x-oauth-scopes** — classic 토큰·`gh` 로그인으로 GitHub를 부를 때 응답에 오는, 그 토큰의 권한 범위 목록 헤더. fine-grained 토큰에는 없다. → contracts §3.1
- **xid8 (트랜잭션 번호)** — PostgreSQL이 트랜잭션마다 매기는 64비트 번호. 위쪽 32비트를 epoch라고 한다(프로젝트 초기화 번호 epoch와는 다른 말). 보고서 상태 이력이 이 번호로 커밋 시각을 찾는다. → docs/ops/operations.md §7.2
- **YAML** — 들여쓰기로 구조를 적는 사람이 읽기 쉬운 설정 파일 형식.
- **zip** — 여러 파일을 하나로 묶은 압축 파일 형식.
- **µs** — 마이크로초. 100만분의 1초.

## ㄱ

- **가동률** — 실제로 일할 수 있는 시간의 비율. 일정 계산(낙관·중간·비관)에 쓴다. → architecture D-32
- **가변 글꼴 (Variable font)** — 파일 하나로 굵기를 자유롭게 바꾸는 글꼴. 화면은 이것을 쓰지만, Chromium PDF에서는 굵은 글자가 Type3 그림 글자가 된다. ↔ 고정 굵기 글꼴
- **가상 스크롤** — 긴 목록에서 화면에 보이는 행만 그려 빠르게 만드는 기법.
- **개발 폴더 / 검증 폴더** — Task 브랜치마다 두는 작업 폴더 두 개. 개발 폴더(`w-<hash>-dev`)는 dev·rework가 다시 쓰고, 검증 폴더(`w-<hash>-qa`)는 qa·reverify마다 ①이 검사한 커밋으로 새로 만든다. → agent-runner/src/jobs/README.md 「작업 폴더 규칙」
- **검증** — QA·재검증 시도가 Task 결과를 확인하는 것. 결과는 `verifications`에 추가 전용으로 남는다. → data-model §2.5
- **격리 테스트(quarantined)** — 불안정해서 야간 점검 판정에서 따로 다루기로 팀장이 표시한 테스트. Runner는 정책 `ci.quarantined[]`로 받는다. → contracts §3.1
- **결과 미확정 (병합)** — 병합 요청의 응답을 잃었는데 조회에서 병합이 보이지 않는 상태. 「병합 안 됨」으로 확정하지 않고, 같은 요청을 다시 보내지 않으며, 쓰기 없는 재조회로만 해소한다. → contracts §3.4-6·§4.1
- **결함(defect)** — 검증에서 찾은 문제. 원 행은 바꾸지 않고 해소는 이벤트 행으로 남긴다. → data-model §2.5
- **경계 변환** — DB에 저장한 값과 API 값의 철자가 다를 때, 서버가 DB↔API 사이에서 바꿔 주는 것. 예: CI 단계 DB `1` ↔ API `task`. → contracts §1 값 철자
- **계열 (Codex 모델 계열)** — Codex 모델 이름 끝부분(luna·terra·astra·sol). 같은 세대 안의 등급 순서를 정한다. 초기 순서는 luna < terra < astra < sol. → data-model §6.2
- **고정 굵기 글꼴 (static font)** — 굵기마다 따로 만든 글꼴 파일(예: Regular 400, Bold 700). 보고서 PDF는 이 파일 4개(400·500·600·700)를 넣는다. ↔ 가변 글꼴
- **고정 벡터** — 입력과 정답(예: 지문·암호문)을 고정해 둔 시험 예시. 따로 만든 두 구현이 같은 결과를 내는지 확인한다. 수학의 벡터가 아니다. → data-model §2.3-1, contracts §6.1
- **관측 등급** — CLI 버전·모델·옵션 조합별로 등록하는 관측 검증 결과(`cli_observation_grades`). 등록된 검증이 없으면 「미검증」으로 보고 보수 계산한다. → architecture §5.1, data-model §2.6
- **교차 리뷰** — 담당이 아닌 쪽 Agent가 결과를 검토하는 것. → milestones §1
- **교착(deadlock)** — 둘 이상이 서로 상대를 기다리느라 아무도 진행하지 못하는 상태. → architecture D-04, data-model §5.1
- **그림 글자** — Type3를 보라.
- **기준 실패** — Task 브랜치가 아니라 기준(main) 쪽에서 난 실패(`failScope=baseline`). Task 잘못이 아니므로 재작업 횟수에 세지 않고, main이 움직이면 다시 통합한다. → contracts §3.5
- **기준 일정(baseline)** — 비교의 기준으로 고정해 둔 일정 버전. → data-model §2.7

## ㄴ

- **낙관 / 비관** — 추정의 짧은 쪽(lo)과 긴 쪽(hi). → data-model §2.3
- **네트워크 공간(network namespace)** — 컨테이너가 쓰는 주소·포트의 묶음. 운영 구성에서 api는 web의 네트워크 공간을 같이 써서 `127.0.0.1`에서만 듣는다. → docs/ops/operations.md §1.4
- **논리 잠금(lock)** — 「이 Task·충돌 묶음은 지금 이 job이 맡고 있다」는 표시. 개발→①→QA 동안 유지한다. → data-model §2.5-1

## ㄷ

- **단조 시계** — 컴퓨터 시각이 바뀌어도 뒤로 가지 않는 시계. 시간 간격을 잴 때 벽시계 대신 쓴다. → architecture §6.4
- **단조 증가** — 값이 항상 커지기만 하는 성질. `updated_at`이 그렇다. → data-model §1
- **동기화 사슬** — H→H′→H″처럼 PR에 main을 여러 번 합친 기록을 단계마다 이은 증거. 사슬 전체가 증명되면 QA를 다시 하지 않는다. → contracts §4.1
- **등급** — 시도에 쓸 모델과 Effort의 조합. 재작업 때 상향, 조건에 따라 하향·재판단한다. → architecture D-29·D-30

## ㄹ

- **래퍼(대기 래퍼)** — 실제 명령을 바로 실행하지 않고 허가를 기다렸다가 exec하는 작은 감싸기 프로그램. 기록 전에 Runner가 죽으면 실행하지 않고 끝난다.

## ㅁ

- **멱등(idempotency)** — 같은 요청을 여러 번 보내도 결과가 한 번 보낸 것과 같은 성질. `Idempotency-Key`로 보장한다. → contracts §1
- **명세** — Task의 목적·범위·요구·작업·입출력·AC 등. 착수 승인에 필수 항목이 있다. → contracts §2.5
- **문서 hash (PDF 캐시 키)** — 스냅샷으로 만든 PDF용 HTML의 hash. 캐시 파일 이름에 앞 16자를 넣는다. 서식이 바뀌어 HTML이 달라지면 키도 달라져 PDF를 다시 만든다. → apps/api/src/pdf/service.ts

## ㅂ

- **배치 폭** — 문서를 줄 바꿈·열 너비로 배치할 때 기준이 되는 폭(px). 보고서 PDF는 인쇄 폭(A4 − 좌우 여백 14mm = 182mm ≈ 688px)에 100%로 배치한다. → apps/api/src/pdf/README.md
- **보고서 상태 이력** — 보고서가 「기간 끝 시점의 상태」를 되살리려고 행이 바뀔 때마다 남기는 기록(`state_log`·`global_log`). → data-model §2.7
- **보수 계산** — 관측이 검증되지 않았을 때 자원 사용을 넉넉하게(1+예산) 잡는 계산.
- **보조 속도 제한 (secondary rate limit)** — 짧은 시간에 요청이 몰리면 GitHub가 따로 거는 제한. 429나 「속도 제한 403」으로 온다. → contracts §6
- **보충(fillSkipped)** — Drizzle이 건너뛸 낮은 `when`의 마이그레이션을 먼저 적용하는 단계. 모르는 기록이 있는 DB에서는 하지 않는다. → data-model §6
- **보호 경로** — Agent가 바꾸면 안 되는 경로(`prototype/`·`.agentwbs/`). → architecture §4
- **복원 리허설** — 사고 전에 백업을 새 DB에 되살려 앱이 뜨고 데이터가 같은지 미리 해 보는 시험(`agent-wbs/deploy/restore-rehearsal.sh`). → docs/ops/M8-06-real-env-record.md
- **봉인 형식 v1** — sealed의 바이트 배치와 계산식(X25519 → HKDF-SHA256 → AES-256-GCM)을 정한 이 프로젝트 전용 형식. 서버와 Runner가 공용 고정 벡터로 확인한다. → contracts §6.1
- **부분 unique** — 조건을 만족하는 행들 사이에서만 겹치지 않게 하는 DB 제약. → data-model §2.5-1
- **분할** — Task 하나를 여러 Task로 나누는 것. 분할 기준 10규칙과 순서 보장 판정이 있다. → data-model §2.3-2

## ㅅ

- **상한** — 동시 실행 자원의 한계(전체·Agent별). 서버가 PC 사양 기반으로 계산하거나 직접 지정하고, Runner는 그 안에서 조절한다. → architecture §1, D-11
- **선두 인덱스** — 어떤 열로 시작하는 인덱스. FK 열마다 두어, 가리키는 행을 지우거나 고칠 때 표 전체를 훑지 않게 한다. → data-model §6.1
- **설정 지문** — Runner가 저장소를 등록할 때 잰 `config` 파일의 해시. 하나라도 달라지면 Runner는 시작하지 않는다. → architecture §5 `ci`
- **세대 (Codex 모델 세대)** — Codex 모델 이름의 숫자 부분(5.6·6·6.1·6.2). 숫자로 비교하며 높을수록 위 등급이다. → data-model §6.2
- **순수 함수** — 같은 입력이면 언제나 같은 결과를 내고, 바깥(I/O·현재 시각)을 건드리지 않는 함수. → architecture §3.3
- **스냅샷** — 어느 한 순간의 데이터를 그대로 고정해 저장한 것. 보고서는 스냅샷이라 나중에 바뀌지 않는다.
- **스켈레톤** — 데이터를 불러오는 동안 내용 자리에 보여 주는 회색 윤곽.
- **스키마 레지스트리** — 메시지 데이터 형식(스키마)과 그 버전을 등록·조회하는 서버. Q-14 선택지에 나온다. 패키지 registry와는 다르다.
- **시계 역행** — 컴퓨터 시각이 갑자기 뒤로 가는 일. 이 PC(WSL)에서 실제로 재현돼, 순서 판단을 저장 순번·단조 시계로 바꿨다. → architecture §6.4
- **시도** — attempt 참고.

## ㅇ

- **영속화** — 프로그램이 꺼져도 남도록 디스크(파일·DB)에 저장하는 것.
- **외부 쓰기 관문** — Runner가 Git push·PR·병합 같은 원격 변경을 하기 전에 반드시 지나는 확인 단계(M4 관문: 권한·host·세대·deploy key 확인). job에서 나온 쓰기는 그 앞에 소유 확인(임대·중단)이 더 붙는다. 초기화 정리는 job이 없어 M4 관문만 지난다. → architecture §4
- **원인 후보** — 야간 점검이 실패했을 때 원인일 수 있는 커밋 목록. → contracts §3.6-2
- **원자적** — 전부 되거나 전부 안 되거나 둘 중 하나만 일어나는 성질. 중간 상태가 남지 않는다.
- **이력 재작성(입력)** — 서버가 마지막으로 받은 입력 커밋이 새 main의 조상이 아니게 된 상태(강제 push 등). 서버는 입력 변경을 받지 않고 경고 `input_history_rewritten`을 연다. owner가 정상 merge·복원 커밋으로 연결을 되돌리고 팀장이 「복구 확인·입력 확인 다시 시도」를 누르면 Runner가 다시 관측하고, 서버가 유효 보고를 받으며 경고를 닫는다. → contracts §2.2 `inputs/recheck`
- **인계(handover)** — 논리 잠금을 다음 job(예: dev→QA)에 끊김 없이 넘기는 것. → data-model §2.5-1
- **인수** — owner가 받아들일 수 있는 상태인지 실제 환경에서 확인하는 단계(M8). → milestones §3 M8
- **일시 장애** — 통신 실패·5xx·속도 제한처럼 잠시 뒤 다시 하면 나을 수 있는 실패. 시작 점검의 deploy key 조회는 최대 3번 다시 하고, 그래도 안 되면 경고만 남긴다. → contracts §3.1
- **입력 원장** — 팀장 입력(`prototype/`)이 언제 어떻게 바뀌었는지 이어 붙여 기록하는 서버의 장부. 정답은 base와 head 사이의 트리 차이다. → contracts §3.1 입력 변경 보고
- **입력 사본** — 입력 커밋의 `prototype/`을 읽기 전용(파일 0444, 폴더 0555)으로 꺼내 둔 폴더. Agent가 입력 문서를 읽기만 하게 한다. 위치는 지시문 끝 「[Runner 안내]」에 적힌다. → agent-runner/src/git/README.md 「입력과 Task 검사」

## ㅈ

- **자기 보유** — 요청한 job 자신의 보유 행. claim·start 때 충돌 검사에서 제외한다. → data-model §2.5-1
- **자손 프로세스** — 어떤 프로세스가 띄운 자식, 그 자식이 띄운 손자 프로세스 전부.
- **작업 불가일(blackout)** — 일정 계산에서 일하지 않는 날. → data-model §2.7
- **재번호** — 여러 작업이 따로 받은 마이그레이션 번호를 통합 직전에 빈틈 없이 다시 매기는 일. 내용(hash)은 바꾸지 않는다. → data-model §6
- **재작업** — QA FAIL이나 통합 실패 뒤 고치는 시도. Task당 자동 최대 3회. → contracts §3.5
- **재조정(replan)** — 실제 진행에 맞춰 일정을 다시 계산하는 것. → architecture D-10
- **재판단** — 모델 허용이 해제됐을 때 등급을 다시 정하는 것(D-29). → architecture §7
- **저장 순번** — `record_no` 항목을 보라.
- **적대적 검증** — 일부러 깨뜨리려는 입장에서 시험하는 것. → milestones §1
- **적용 누락 검사** — journal의 모든 마이그레이션이 DB 기록에 있는지 확인하는 검사. 빠지면 `MigrationGapError`로 멈춘다. → data-model §6
- **정규화** — 같은 내용이면 항상 같은 글자열이 되도록 순서·공백 등을 맞추는 것. hash를 비교하기 전에 한다.
- **정리 명령** — 초기화 뒤 Runner가 가장 먼저 해야 하는 청소 작업(`reset-cleanup`). → contracts §3.2
- **정리 증거(holds[])** — 정리 명령을 끝냈다고 보고할 때 보유마다 붙이는 증거(`no_process`·`group_empty`·`boot_changed`). DB `complete_cleanup()`이 기록된 보유와 대조한다. → contracts §3.2, data-model §5
- **정본** — 여러 사본이 다르면 이것이 맞다고 정한 원본. → architecture §1
- **정합성 / 무결성 점검** — 저장된 데이터끼리 서로 모순이 없는지(예: 열린 시도가 2개) 검사하는 것.
- **종류 변경(T)** — 입력 차이의 상태 값. 같은 경로가 일반 파일에서 심볼릭 링크로(또는 반대로) 바뀐 것이다. 내용 변경으로 센다. → contracts §3.1 입력 변경 보고
- **중단 기록** — push를 중단했거나 결과를 모를 때 Runner가 남기는 메모. 다음 push 전에 원격을 다시 읽게 만든다. → architecture §4 「외부 쓰기 관문」
- **지수 백오프** — 실패할 때마다 기다리는 시간을 두 배씩 늘리는 재시도 방법(1s→60s).
- **직렬화** — 동시에 들어온 일을 한 번에 하나씩 차례로 처리하게 만드는 것.

## ㅊ

- **차단** — 선행이 아직 충족되지 않아 시작할 수 없는 상태. 저장하지 않고 계산한다. → data-model §3.1
- **착수 승인** — 팀장이 Task 실행을 허락하는 승인. Gate의 「필요한 승인」이 이것이다(Q-02). → data-model §3.1
- **초기화** — 프로젝트 데이터를 지우고 epoch를 올리는 작업. → data-model §5
- **추가 전용** — 한 번 쓴 행을 고치거나 지우지 않고 새 행만 더하는 테이블(이력 등). → architecture §4
- **충돌 묶음(conflictGroup)** — 같은 파일·설계를 건드려 동시에 실행하면 부딪치는 Task들의 묶음 이름. 같은 묶음은 한 번에 하나만 실행한다. → data-model §2.4-1

## ㅋ

- **커밋 시계(`log_clock`)** — 커밋 순서대로 매기는 단조 증가 시각. PC 시계가 뒤로 가도 줄지 않는다. 보고서가 「그 시점 전」을 가를 때 쓴다. → data-model §2.7

## ㅌ

- **트랜잭션** — 여러 DB 변경을 하나로 묶어, 전부 반영되거나 전부 취소되게 하는 단위.
- **트리거** — 행을 쓸 때마다 DB가 자동으로 실행하는 검사 함수. CHECK와 달리 「바뀌기 전 값」을 볼 수 있다. → data-model §2.4 `change_proposals`

## ㅍ

- **파일 모드(mode)** — git이 파일마다 적는 6자리 8진수 값. `100644`는 일반 파일, `100755`는 실행 파일, `120000`은 심볼릭 링크다. → contracts §3.1 입력 변경 보고
- **판단 기록(judgedRules)** — 분할 규칙 5·7·9 등에 대해 Planning이 내린 결론·합의 주체·근거 기록. → data-model §2.3-1
- **판정** — 규칙에 따라 옳고 그름·가능 여부를 정하는 것. 모든 판정은 Agent WBS가 한다. → architecture §1

## ㅎ

- **하위 Agent 비율** — 실행 세션 하나가 평균 몇 개의 하위 Agent를 띄우는지. 일정 계산이 관측 창 동안의 실제 보고로 계산하고, 관측이 없으면 0으로 둔다. → data-model §2.6
- **하위 Agent(subagent)** — Agent가 일을 나눠 맡기는 보조 Agent. 정의는 hash로 검증해 설치한다. → architecture D-24
- **해석 결정** — D-xx 참고.
- **헬스체크(healthcheck)** — 컨테이너가 정상인지 docker가 주기적으로 묻는 검사. 운영 구성은 postgres(`pg_isready`)·web·api(`/health/db`)에 둔다. → docs/ops/operations.md §1
- **협조적 검사** — 상대가 규칙을 지킬 때만 통하는 검사. 옛 PC가 이미 보낸 GitHub 요청은 막지 못하므로 자격 증명 폐기와 결과 대조가 최종 방어다.
- **형식 수정 요청** — Agent 종료 메시지가 계약(JSON Schema)과 맞지 않을 때 같은 세션에 한 번만 보내는 다시 내기 요청. 그래도 틀리면 개발 시도는 실패로 보고하고, QA 시도는 판정을 지어내지 않고 멈춘다. → contracts §5, agent-runner/src/jobs/README.md 「결과 수집」
