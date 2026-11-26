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
- **AC (Acceptance Criteria, 수용 기준)** — 「이렇게 되면 완료로 인정한다」는 조건. given/when/then/method로 적는다. → data-model §2.3
- **Agent** — 일을 하는 AI 프로그램. 이 프로젝트에서는 Claude와 Codex다.
- **Agent Runner (Runner)** — 개발 PC에서 Agent 세션을 실행하고 결과를 보고하는 프로그램(`agent-runner/`). 판정은 하지 않는다. → architecture §1
- **Agent WBS (WBS)** — 팀장용 웹 화면·REST API·PostgreSQL로 된 시스템(`agent-wbs/`). 모든 판정을 한다. → architecture §1
- **aggregate (비교 대상)** — 동시 수정을 막을 때 버전을 비교하는 기준 행. → contracts §1.3
- **allowlist** — 허용 목록에 있는 것만 통과시키는 방식. Agent에 넘기는 환경 변수를 이렇게 고른다. → architecture §4
- **API** — 프로그램끼리 요청·응답을 주고받는 약속된 창구.
- **AsyncAPI** — 메시지(이벤트) 기반 API를 적는 표준 형식. → open-questions Q-14
- **attempt (시도)** — Agent가 Task를 한 번 실행하는 단위. 종류는 dev·qa·rework·reverify. → data-model §3.2
- **BLOCKED** — 검증 결과의 하나. 환경 문제 등으로 판정하지 못했다는 뜻이며 Task 상태는 그대로 두고 새 검증 시도를 한다. → data-model §3.1
- **boot ID** — PC가 켜질 때마다 새로 바뀌는 식별자. 바뀌었으면 이전 프로세스가 살아 있을 수 없다는 증거가 된다. → contracts §3.4
- **bootstrap (초기 분석)** — 저장소를 등록한 뒤 Planning이 처음 WBS 초안을 만드는 작업. → data-model §2.2
- **CI** — 빌드·테스트를 자동으로 돌리는 과정. 이 프로젝트에서는 ①~④ 4단계. → architecture §5
- **cgroup** — 리눅스가 프로세스 묶음의 CPU·메모리 사용을 재고 제한하는 기능. → architecture §5
- **claim** — Runner가 job을 「제가 하겠습니다」 하고 예약하는 요청. 예약만 하고 시도는 만들지 않는다. → contracts §3.2
- **CLI** — 명령줄에서 쓰는 프로그램. 여기서는 주로 Codex CLI·Claude Code CLI.
- **CODEOWNERS** — GitHub에서 특정 경로를 바꿀 때 지정된 사람의 검토를 요구하는 설정. → contracts §4.1
- **coordinator** — owner와 작업자 사이에서 일을 나누고 전달하는 조정자. → open-questions §0
- **CP (Change Proposal, 변경 제안)** — Task를 추가·수정·취소·분할하자는 제안. 미리보기 후 승인·반영한다. → data-model §3.6
- **CSP** — 브라우저가 실행할 수 있는 스크립트 출처를 제한하는 보안 헤더. → architecture §4
- **CSRF** — 다른 사이트가 몰래 사용자 대신 요청을 보내는 공격. `X-CSRF-Token`으로 막는다. → architecture §4
- **cursor (커서)** — 「어디까지 읽었는지」를 나타내는 값. 목록 페이지나 변경 이벤트에서 쓴다. → contracts §7
- **D-xx (해석 결정)** — 가이드가 애매하거나 서로 부딪치는 곳을 이 문서가 정한 결정 번호. → architecture §7
- **demo seed** — 테스트·화면 검증 전용 기본 데이터. 운영 DB에는 넣지 않는다. → data-model §6
- **diff** — 두 내용의 차이. CP 미리보기의 `diff`는 바뀌는 필드 목록이다.
- **digest** — 컨테이너 이미지의 고유 지문. 같은 digest면 정확히 같은 이미지다. → architecture §3.2
- **drift** — 두 사본(예: 문서와 openapi.json, 계약과 코드)이 서로 어긋난 상태. → contracts 머리말, data-model §2.8
- **DTO** — 요청·응답으로 주고받는 데이터 모양. → architecture §3.3
- **E2E** — 화면부터 서버·DB까지 실제처럼 이어서 하는 끝-끝 테스트.
- **Effort** — Agent가 얼마나 깊이 생각할지 정하는 단계. 공통 1~5로 맞춘다. → open-questions §0.2
- **enum** — 정해진 값 중 하나만 허용하는 DB 타입. → data-model §1
- **epoch** — 프로젝트 세대 번호. 초기화할 때마다 1 오르며, 옛 세대의 요청이 새 프로젝트를 건드리지 못하게 한다. → contracts §1, data-model §5.1
- **Evidence (검증 증거)** — 검증 결과를 뒷받침하는 파일(로그·스크린샷 등). → data-model §2.5
- **fake** — 실제 외부 서비스(Claude·Codex·GitHub·SMTP 등) 대신 쓰는 가짜 구현. 돈이 들지 않고 결과가 일정해 테스트에 쓴다. → milestones §1
- **fence** — 낡은 Runner의 보고를 막는 번호표. job을 새로 임대할 때마다 바뀌고, 낡은 fence의 보고는 409 LEASE_LOST로 거절된다. → contracts §3.2
- **FK / PK** — FK(외래 키)는 다른 테이블 행을 가리키는 열, PK(기본 키)는 행을 구분하는 고유 번호. → data-model §1
- **fixture** — 테스트에 쓰는 고정 데이터.
- **FS / SS** — 의존성 종류. FS(Finish-to-Start)는 「선행이 끝나야 후속 시작」, SS(Start-to-Start)는 「선행이 시작되면 후속 시작 가능」. → data-model §2.3, §3.1
- **G** — 가이드. `prototype/docs/Agent-WBS-설계의도-및-구현가이드.md`. 원본끼리 충돌하면 G가 우선한다.
- **G L123 / P L456** — 가이드 123번째 줄, 프로토타입 456번째 줄. 출처를 가리키는 표기.
- **Gate** — Task를 완료로 판정하기 전에 모두 통과해야 하는 조건 묶음(5조건). → data-model §3.1
- **gate (owner 결정 gate)** — owner의 답이 있어야 열리는 관문. 답 전에는 fake·잠정 fixture까지만 만든다. → open-questions §1
- **generation** — PC(host)가 바뀔 때마다 1 오르는 외부 쓰기 권한 세대 번호. → contracts §3.4
- **gh** — GitHub 공식 CLI.
- **git-lfs** — 큰 파일을 git 밖에 저장하는 git 확장.
- **hash** — 내용을 짧은 문자열로 줄인 지문. 내용이 조금만 바뀌어도 달라진다. → data-model §2.3-1
- **headSha** — 브랜치 맨 끝 커밋의 고유 번호(SHA). 검증한 코드를 고정하는 데 쓴다. → contracts §4.1
- **heartbeat** — Runner가 「아직 살아 있다」고 60초마다 보내는 신호. 3회 누락이면 끊긴 것으로 본다. → contracts §3.1
- **hold (보유)** — job이 차지한 물리 슬롯과 논리 잠금의 기록. → data-model §2.5-1
- **host** — Runner가 도는 PC.
- **HttpOnly / SameSite=Strict** — 쿠키를 스크립트가 읽지 못하게 하고, 다른 사이트에서 온 요청에는 붙지 않게 하는 쿠키 설정. → architecture §4
- **job (작업)** — Runner에게 맡기는 일 한 건. 종류는 contracts §3.2의 표에 있다.
- **jitter** — 재시도 대기 시간을 조금씩 흩뜨려 요청이 한꺼번에 몰리지 않게 하는 것. → contracts §1.2
- **JSON Schema** — JSON 데이터의 모양을 정의하고 검사하는 형식. → contracts §5
- **KST** — 한국 표준시(Asia/Seoul).
- **LAN** — 같은 사무실·집 안의 네트워크. LAN 접속은 비밀번호로 로그인한다. → architecture §4
- **lease (임대)** — 「이 job은 정해진 시간 동안 이 Runner가 맡는다」는 표시. 60초, 20초마다 renew. 만료돼도 자원 해제는 아니다. → contracts §3.2
- **lockfile** — 설치한 패키지의 정확한 버전을 고정해 두는 파일. → architecture §3.2
- **loopback** — 같은 PC 안에서 자기 자신에게 접속하는 연결(`127.0.0.1`). 1회용 링크 로그인은 loopback에서만 된다. → architecture §4
- **M0~M8 / Mx-yy** — 마일스톤과 작업 ID. 예: `M2-05`는 2단계의 5번째 작업. → milestones §1
- **Mock** — 가짜 데이터로 움직이는 시안. 프로토타입(P)이 Mock이다. 제품 규칙의 근거로는 G가 우선한다.
- **multipart** — 파일을 HTTP로 올릴 때 쓰는 요청 형식. → contracts §3.1
- **OpenAPI** — REST API의 경로·요청·응답을 기계가 읽게 적는 표준 문서 형식. 두 시스템이 공유하는 유일한 것. → architecture §1
- **orphaned** — host가 바뀌어 효력만 없앤 옛 잠금 상태(감사용). → data-model §2.5-1
- **outbox** — 보낼 것을 먼저 저장해 두고 나중에 보내는 대기함. 끊겨도 다시 보낼 수 있다. → architecture §2
- **owner** — 이 프로젝트의 최종 결정권자. → open-questions
- **P** — 프로토타입. `prototype/uiux/Main.dc.html`.
- **payload** — 요청이나 job에 실어 보내는 실제 내용.
- **pgid (process group ID)** — 프로세스 그룹 번호. Agent가 띄운 자식 프로세스까지 한꺼번에 관리·종료하는 데 쓴다. → contracts §3.4
- **Planning (Planning Agent)** — 계획(WBS 초안·추정·분할·판단)을 세우는 Agent 작업. Claude·Codex가 각자 분석하고 교차 검토한다. → architecture §5
- **polling** — 일정 간격으로 「바뀐 것 있나요?」 하고 묻는 방식. Runner→WBS, 화면→서버 모두 polling이다. → architecture §1, §2.1
- **PR (Pull Request)** — GitHub에서 브랜치 변경을 main에 합쳐 달라는 요청. Task당 1개. → contracts §6
- **principal** — 요청한 주체(`lead` 팀장 또는 `runner`). → architecture §4
- **proof (해제 증거)** — 보유를 풀어도 된다는 증거. `no_process`·`group_empty`·`boot_changed` 세 가지. → contracts §3.4
- **Q-xx** — owner에게 묻는 질문 번호. 답이 나온 것은 open-questions §0, 남은 것은 §2. → open-questions
- **QA** — 개발 결과를 다른 Agent가 검증하는 단계. 결과는 PASS·FAIL·BLOCKED. → data-model §3.1
- **R1~R6, P1~P3** — 리뷰 지적 번호와 심각도(P1이 가장 무겁다). → milestones §6
- **readiness (준비 상태)** — Runner가 일할 준비가 됐는지(CLI·git·디스크 등) 점검한 결과. → architecture §5
- **reconcile (대조)** — 끊긴 외부 작업이 실제로 어디까지 됐는지 GitHub 등을 조회해 확인하는 것. → contracts §3.4
- **redact / 마스킹** — 로그에서 토큰·비밀번호를 가리는 것. → architecture §4
- **renew** — lease를 연장하는 요청. → contracts §3.2
- **rework / reverify** — 재작업 시도와, 재작업 후의 재검증 시도. → data-model §3.1
- **run-grade** — 이번 시도에 쓸 모델·Effort를 서버에 묻는 API. → contracts §3.1
- **scope (systemd scope)** — systemd가 프로세스 묶음을 하나로 관리하는 단위. cgroup을 만든다. → open-questions §3
- **seed** — 빈 DB에 처음 넣는 기본 데이터. `system`과 `demo` 두 가지. → data-model §6
- **semaphore** — 동시에 정해진 개수만 실행되게 막는 번호표 장치. → architecture §5
- **SHA** — git 커밋의 고유 번호(hash).
- **slot (물리 슬롯)** — PC의 CPU·메모리 같은 실행 자리. 프로그램이 실제로 돌 때만 잡는다. → data-model §2.5-1
- **SMTP** — 메일을 보내는 표준 방식(메일 서버). → contracts §4.4
- **soft delete** — 행을 지우지 않고 「지움」 표시(`deleted_at`)만 하는 방식. → data-model §1
- **SSE / WebSocket** — 서버가 화면으로 바로 밀어 주는 실시간 통신 방식. 이 제품 런타임에는 쓰지 않는다(D-02). → architecture §2.1
- **strict (up-to-date 보호)** — main 최신을 포함하고 필수 검사를 통과해야 병합을 허락하는 GitHub 브랜치 보호 설정. → contracts §4.1
- **Task** — WBS에서 일 한 건. ID는 `TASK-` + 숫자 4자리 이상. → data-model §2.3
- **telemetry** — Runner의 상태 보고(heartbeat·host·readiness 등). fence 없이 보낸다. → contracts §3.2
- **TypeBox** — TypeScript로 스키마를 정의해 검증·타입·OpenAPI를 한 번에 만드는 도구. → architecture §3.2
- **UTC** — 세계 표준시. 시각은 UTC로 저장하고 한국 시간으로 보여 준다. → architecture §6.4
- **WBS (Work Breakdown Structure)** — 일을 단계·작업 묶음·Task로 쪼갠 구조. 이 제품의 이름이기도 하다.
- **worker** — 보고서·메일·알림·감시 같은 뒷일을 맡는 서버 프로세스. → architecture §2
- **worktree** — 같은 git 저장소를 작업마다 따로 꺼내 둔 작업 폴더. Agent는 이 안에서만 일한다. → architecture §1
- **WSL** — Windows에서 리눅스를 돌리는 환경. 개발 PC가 WSL2다. → architecture §5

## ㄱ

- **가동률** — 실제로 일할 수 있는 시간의 비율. 일정 계산(낙관·중간·비관)에 쓴다. → architecture D-32
- **검증** — QA·재검증 시도가 Task 결과를 확인하는 것. 결과는 `verifications`에 추가 전용으로 남는다. → data-model §2.5
- **결함(defect)** — 검증에서 찾은 문제. 원 행은 바꾸지 않고 해소는 이벤트 행으로 남긴다. → data-model §2.5
- **관측 등급** — CLI 버전·모델·옵션 조합별로 등록하는 관측 검증 결과(`cli_observation_grades`). 등록된 검증이 없으면 「미검증」으로 보고 보수 계산한다. → architecture §5.1, data-model §2.6
- **교착(deadlock)** — 둘 이상이 서로 상대를 기다리느라 아무도 진행하지 못하는 상태. → architecture D-04, data-model §5.1
- **교차 리뷰** — 담당이 아닌 쪽 Agent가 결과를 검토하는 것. → milestones §1
- **기준 일정(baseline)** — 비교의 기준으로 고정해 둔 일정 버전. → data-model §2.7

## ㄴ

- **낙관 / 비관** — 추정의 짧은 쪽(lo)과 긴 쪽(hi). → data-model §2.3
- **논리 잠금(lock)** — 「이 Task·충돌 묶음은 지금 이 job이 맡고 있다」는 표시. 개발→①→QA 동안 유지한다. → data-model §2.5-1

## ㄷ

- **단조 증가** — 값이 항상 커지기만 하는 성질. `updated_at`이 그렇다. → data-model §1
- **등급** — 시도에 쓸 모델과 Effort의 조합. 재작업 때 상향, 조건에 따라 하향·재판단한다. → architecture D-29·D-30

## ㅁ

- **멱등(idempotency)** — 같은 요청을 여러 번 보내도 결과가 한 번 보낸 것과 같은 성질. `Idempotency-Key`로 보장한다. → contracts §1
- **명세** — Task의 목적·범위·요구·작업·입출력·AC 등. 착수 승인에 필수 항목이 있다. → contracts §2.5

## ㅂ

- **보호 경로** — Agent가 바꾸면 안 되는 경로(`prototype/`·`.agentwbs/`). → architecture §4
- **부분 unique** — 조건을 만족하는 행들 사이에서만 겹치지 않게 하는 DB 제약. → data-model §2.5-1
- **분할** — Task 하나를 여러 Task로 나누는 것. 분할 기준 10규칙과 순서 보장 판정이 있다. → data-model §2.3-2

## ㅅ

- **상한** — 동시 실행 자원의 한계(전체·Agent별). 서버가 PC 사양 기반으로 계산하거나 직접 지정하고, Runner는 그 안에서 조절한다. → architecture §1, D-11
- **순수 함수** — 같은 입력이면 언제나 같은 결과를 내고, 바깥(I/O·현재 시각)을 건드리지 않는 함수. → architecture §3.3
- **시도** — attempt 참고.

## ㅇ

- **원자적** — 전부 되거나 전부 안 되거나 둘 중 하나만 일어나는 성질. 중간 상태가 남지 않는다.
- **인계(handover)** — 논리 잠금을 다음 job(예: dev→QA)에 끊김 없이 넘기는 것. → data-model §2.5-1
- **인수** — owner가 받아들일 수 있는 상태인지 실제 환경에서 확인하는 단계(M8). → milestones §3 M8

## ㅈ

- **자기 보유** — 요청한 job 자신의 보유 행. claim·start 때 충돌 검사에서 제외한다. → data-model §2.5-1
- **작업 불가일(blackout)** — 일정 계산에서 일하지 않는 날. → data-model §2.7
- **재작업** — QA FAIL이나 통합 실패 뒤 고치는 시도. Task당 자동 최대 3회. → contracts §3.5
- **재조정(replan)** — 실제 진행에 맞춰 일정을 다시 계산하는 것. → architecture D-10
- **재판단** — 모델 허용이 해제됐을 때 등급을 다시 정하는 것(D-29). → architecture §7
- **적대적 검증** — 일부러 깨뜨리려는 입장에서 시험하는 것. → milestones §1
- **정리 명령** — 초기화 뒤 Runner가 가장 먼저 해야 하는 청소 작업(`reset-cleanup`). → contracts §3.2
- **정본** — 여러 사본이 다르면 이것이 맞다고 정한 원본. → architecture §1
- **착수 승인** — 팀장이 Task 실행을 허락하는 승인. Gate의 「필요한 승인」이 이것이다(Q-02). → data-model §3.1

## ㅊ

- **차단** — 선행이 아직 충족되지 않아 시작할 수 없는 상태. 저장하지 않고 계산한다. → data-model §3.1
- **초기화** — 프로젝트 데이터를 지우고 epoch를 올리는 작업. → data-model §5
- **추가 전용** — 한 번 쓴 행을 고치거나 지우지 않고 새 행만 더하는 테이블(이력 등). → architecture §4
- **충돌 묶음(conflictGroup)** — 같은 파일·설계를 건드려 동시에 실행하면 부딪치는 Task들의 묶음 이름. 같은 묶음은 한 번에 하나만 실행한다. → data-model §2.4-1

## ㅌ

- **트랜잭션** — 여러 DB 변경을 하나로 묶어, 전부 반영되거나 전부 취소되게 하는 단위.

## ㅍ

- **판단 기록(judgedRules)** — 분할 규칙 5·7·9 등에 대해 Planning이 내린 결론·합의 주체·근거 기록. → data-model §2.3-1
- **판정** — 규칙에 따라 옳고 그름·가능 여부를 정하는 것. 모든 판정은 Agent WBS가 한다. → architecture §1

## ㅎ

- **하위 Agent(subagent)** — Agent가 일을 나눠 맡기는 보조 Agent. 정의는 hash로 검증해 설치한다. → architecture D-24
- **해석 결정** — D-xx 참고.
