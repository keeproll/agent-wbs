# Agent WBS

Web UI · REST API · PostgreSQL. 계획은 [`docs/plan`](../docs/plan/architecture.md)에 있다.

Node 26.13 이상(26 계열)과 pnpm 12.16.1이 필요하다. 저장소 루트에서 실행한다.

```sh
pnpm -C agent-wbs env:init          # .env 생성(무작위 DB 비밀번호, 커밋하지 않음). 최초 1회
docker compose -p awbs -f agent-wbs/compose.yaml up -d --wait postgres
pnpm -C agent-wbs install --frozen-lockfile
pnpm -C agent-wbs db:migrate
pnpm -C agent-wbs --filter @awbs/db seed:system # 필수 기본 설정을 넣음. 없으면 Runner 상태를 읽을 수 없음
pnpm -C agent-wbs dev               # web 127.0.0.1:5173, api 127.0.0.1:3100
```

| 명령 | 내용 |
|---|---|
| `pnpm check` | typecheck + lint + 단위 테스트(DB 불필요) |
| `pnpm build` | 전체 빌드 |
| `pnpm test:db` | 실제 PostgreSQL 테스트. `TEST_DATABASE_URL`이 `awbs_test_` DB가 아니면 거부 |
| `pnpm --filter web e2e:install` | Playwright Chromium을 사용자 캐시에 설치 |
| `pnpm --filter web test:e2e` | 브라우저 테스트 |

특정 테스트만 실행하려면 `-- <이름>`을 붙인다(예: `pnpm test:db -- guard`).

DB 비밀번호는 PC당 하나(`~/.agentwbs/wbs/dev-db-password`, 0600)이며 여러 worktree가 같은 컨테이너를 쓴다.
테스트 DB는 worktree마다 다르다. 컨테이너 중지는 `docker compose -p awbs -f agent-wbs/compose.yaml stop`이다.

## 초기 분석의 사람 결정 대기

Runner(서버 작업을 실행하고 결과를 보고하는 프로그램)가 기술 결정 제안이나 초안을 저장하면 다음 처리는 팀장이 맡는다.
`tech:run`은 기술 결정 확정 대기다. `approve:run`은 저장된 초안 승인 대기다.
이때 Runner 작업이 성공·실패·취소로 끝나거나 임대(정해진 시간 동안의 실행 권한)가 만료되어도 초기 분석을 실패로 바꾸지 않는다.
PC 재시작이나 교체도 같은 규칙을 따른다.
왜 이렇게 하나: Runner가 맡은 자료 저장은 끝났으므로, 연결 중단 때문에 사람의 결정 대기를 실패로 취급하면 안 된다.

사람 결정 대기 중에는 「다시 시도」로 Runner 작업을 만들지 않는다.
reconcile(끊긴 작업의 실제 결과를 대조하는 복구 처리)도 대체 작업을 만들지 않는다.
기술 결정을 확정하면 `draft` 작업이 만들어진다. 초안을 승인하면 초기 분석이 완료된다.
실제 분석 실패의 `resumeStep`(재개 단계)은 DB(데이터베이스)에 저장된 단계 순서에서 처음으로 `done`이 아닌 단계로 정한다.
재분석 때문에 단계들을 초기화한 경우에도 초기화한 DB 상태로 계산한다.
저장된 상태에서 Runner가 재개할 단계가 없으면 거부한다.
왜 이렇게 하나: 실패 표시가 없다고 `null`(처음부터)을 추측하면 이미 저장한 제안이나 초안을 다시 만들 수 있다.

용어: Runner는 작업 실행 프로그램이다. 임대는 일정 시간의 실행 권한이다.
reconcile은 끊긴 작업의 결과 대조다. `resumeStep`은 재개할 단계다. DB는 데이터베이스다.

## 판단과 입력 지문

`sourceRef`는 판단할 때 실제로 본 입력의 지문이다.
형식은 `sha256:<64 hex>`이며, `hex`에는 소문자 16진수 64자만 쓴다.
JSON(JavaScript Object Notation)은 내용과 값을 문자열로 표현하는 형식이다.
일반 Task(작업)의 지문은 `JudgedContent`(판단에 영향을 주는 작업 내용)를 JCS(JSON Canonicalization Scheme, 같은 내용을 항상 같은 JSON 문자열로 만드는 규칙)로 직렬화해서 계산한다.
JCS는 [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)를 따른다.
그 문자열의 UTF-8(문자열을 바이트로 바꾸는 인코딩) 바이트를 SHA-256(Secure Hash Algorithm 256, 내용을 256비트 지문으로 만드는 계산법)에 넣은 값이 `subjectHash`다.
`sourceRef`는 `sha256:` 뒤에 그 값을 붙인다.
왜 이렇게 하나: 판단 뒤에 작업 내용이 바뀌면 같은 판단을 새 내용의 판단으로 받아들이면 안 된다.

`JudgedContent`는 `title`, `scope`, `out`, `doneCond`, `spec`, `ac`, `outputs`, `designs`, `conflictGroup`으로 구성한다.
`spec`의 10개 칸은 빠진 칸을 빈 목록으로 채운다.
`outputs`는 이름순으로 정렬하고 `delivered`를 뺀다.
`designs`는 `DB`, `API`, `FE`, `DevOps` 순서로 정렬한다.
그 밖의 목록 순서는 유지한다.
새 Task의 생략값과 분할 Task가 상속한 `conflictGroup`도 먼저 확정한다.
Unicode 문자열은 정규화하지 않는다.
잘못된 Unicode나 JSON으로 표현할 수 없는 값은 거부한다.
왜 이렇게 하나: Runner와 서버가 같은 작업을 보고도 서로 다른 지문을 계산하는 일을 막는다.

초안, 변경 제안의 새 Task, `taskJudgements`, Task 재판단, 변경 제안 재판단에 같은 검사를 적용한다.
기존 Task 재판단 요청에 `subjectHash`도 있으면 `sourceRef`의 지문과 함께 변경 후 내용의 서버 계산값에 맞아야 한다.
예를 들어 `conflictGroup`을 바꾸는 요청은 바꾼 묶음으로 판단하고 지문을 계산한다.
지문이 다르면 저장하지 않고 `409 VERSION_CONFLICT`를 보낸다.
응답의 `details.subjectHash`에는 현재 대상의 서버 계산값을 담는다.
형식 자체가 틀린 `sourceRef`는 `400 VALIDATION_FAILED`다.
서버는 옛 판단에 새 내용의 지문을 붙여 주지 않는다.
옛 형식으로 저장된 판단도 유효한 판단으로 취급하지 않으므로 다시 판단해야 한다.
왜 이렇게 하나: 지문을 새로 붙이는 것만으로는 Runner가 새 내용을 실제로 판단했는지 확인할 수 없다.

분할 전체 판단(D-34)의 대상은 기존 `splitSubjectHash` 정의를 유지한다.
판단 기록을 뺀 `ops`와 원래 Task의 내용이 든 `splitTasks`를 `{ops, splitTasks}`로 묶고 같은 JCS·UTF-8·SHA-256 계산을 적용한다.
그 값으로 `sourceRef`를 만든다.
왜 이렇게 하나: 분할 전체 판단은 조각 하나가 아니라 전체 변경과 원래 작업의 관계를 다룬다.

분할 작업의 `payload.tasks[]`와 WBS(Work Breakdown Structure, 작업을 단계와 묶음으로 나눈 구조) 스냅샷의 `tasks[]`에는 `workType`(작업 유형)이 필수다.
같은 Task 입력 구조를 쓰는 재판단·추정 작업에도 `workType`을 담는다.
값은 DB에 저장된 `Analysis`, `Implementation` 등의 유형을 그대로 쓴다.
`workType`은 `JudgedContent` 안에 넣지 않으므로 기존 판단 지문과 고정 벡터는 바뀌지 않는다.
분석 중 제안 대상이나 그 이웃의 작업 유형이 바뀌면 `409 VERSION_CONFLICT`로 거부한다.
왜 이렇게 하나: `Analysis` 조각이 원래 Task의 충돌 묶음을 상속하는지는 원래 작업 유형에 따라 달라진다.
Runner가 유형을 추측하면 잘못된 묶음을 전제로 판단할 수 있다.

언어가 달라도 대조할 수 있는 고정 입력·직렬화 결과·지문은 [`contracts/fixtures/judgement-bindings.json`](contracts/fixtures/judgement-bindings.json)에 있다.
기본 예시의 지문은 `49813649157306979e9b5652a52674817589723f035e668c9b8a9e372027a1cb`다.

용어: `sourceRef`는 판단 입력의 지문을 담는 필드다. `subjectHash`는 서버와 대조할 내용 지문이다.
JCS는 JSON의 표준 직렬화 규칙이다. UTF-8은 문자열을 바이트로 바꾸는 인코딩이다.
SHA-256은 바이트의 지문을 계산하는 함수다. `JudgedContent`는 판단 대상 내용이다.

## 로그인

기본 접속은 이 PC(loopback) 전용이며 `pnpm -C agent-wbs --filter @awbs/api auth login-link`로 받은 1회용 링크를 연다. LAN을 명시적으로 켠 경우 로그인 화면의 6칸에 서버 시간대의 오늘 날짜 PIN(YYMMDD, 예: 2026-11-28 → 261128)을 입력한다. `AWBS_PIN_TIME_ZONE`으로 시간대를 바꿀 수 있고 기본은 `Asia/Seoul`이다. 자정 앞뒤 5초는 경계를 사이에 둔 두 날짜를 허용한다. 로그인 세션은 날짜 변경과 관계없이 원래 12시간 만료까지 유지한다.

**LAN 모드에서는 같은 네트워크 누구나 날짜로 접속 가능하다.** 신뢰하는 네트워크에서만 켜고 기본 loopback 전용 접속을 권장한다. 60초 5회 시도 제한·Origin·CSRF 검사는 유지한다. 기존 LAN 비밀번호 해시는 사용하지 않으며 `auth set-password`는 폐지했다. PIN을 발급·저장하거나 로그로 출력하지 않는다.
