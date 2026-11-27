# 시도 흐름 결합(M5-05)

`AttemptFlow`는 서버가 예약한 시도 하나를 `Execution`에 넘긴다.
개발 → ①(Task 검사) → QA(검증 Agent의 검사) → 재작업 → 재검증 → Gate 대기까지 잇는다.
Gate는 완료 전에 통과해야 하는 조건 묶음이다.
다음 시도의 종류와 등급, 재시도 횟수는 서버가 정한다.
왜: Runner마다 판정하면 같은 결과를 보고도 다음 작업이 달라질 수 있다.
API는 프로그램끼리 요청하고 응답하는 약속이다.
기본 용어는 [프로젝트 용어집](../../../docs/glossary.md)을 함께 참고한다.

기준은 `docs/plan/contracts.md` §3.5·§4.1·§5, owner Q-04·Q-05·Q-07, 가이드 시나리오 6·7·9다.
실제 ①·②(통합 확인)·GitHub 병합·`done`은 M7-06이 연결한다.
실제 실행은 격리 공급원이 없으면 계속 거부한다.
시험의 `fake-only` 격리와 결과 수집기는 실제 실행에 쓰면 안 된다.
왜: 시험용 결과는 실제 코드나 Agent 출력을 검증하지 않는다.

## 사용하는 방법

`RunnerAppDeps.execution`에 기존 작업 폴더 준비와 격리 공급원을 연결한다.
`RunnerAppDeps.jobs`에 `collect`와 필요한 `taskCheck`를 연결한다.
앱은 기존 `Runner`·`Execution`·자원 보고기·발송함을 공유한다.
`jobs`를 연결하지 않은 앱은 시도 예약 반복을 시작하지 않는다.
왜: 결과 수집기가 없는 상태에서 일을 예약하면 작업을 실행해도 유효한 결과를 보고할 수 없다.

- `runNext(capacity, signal?)`: 하나를 예약하고 그 처리까지 기다린다. 일이 없으면 `null`을 돌려준다.
- `poll(capacity, signal?)`: 예약한 일을 별도로 실행한다. 긴 CLI(명령줄 프로그램)가 끝나기를 기다리지 않는다.
- `run(job, signal?)`: 이미 예약한 `attempt` 또는 `stop_attempt`를 처리한다. 동시에 같은 job을 다시 넘기면 같은 Promise를 돌려준다.
- `shutdown()`: 실행 중인 프로세스를 정리하고 진행 중인 흐름이 끝나기를 기다린다.

`capacity`는 기존 보유를 빼기 전 전체 상한이다.
서버가 자기 트랜잭션에서 보유를 뺀다.
앱의 예약 반복은 `ResourceReporter.caps.total`을 사용한다.
왜: Runner도 먼저 빼면 같은 자리를 두 번 빼게 된다.

`poll`의 비동기 오류는 `onError`로 전달한다.
앱은 인증 실패 때 전체 실행을 멈춘다.
나머지는 경고로 남긴다.
`runNext`와 `run`은 오류를 호출자에게 돌려준다.

## M7-06 연결 계약

### 들어오는 값

`AttemptContext`는 다음 값을 받는다.

- `job`: 생성 클라이언트의 원래 `attempt` job이다. `id`, `fence`, `leaseUntil`, `payload`를 보존한다.
- `output`: `Execution.run()`의 결과다. `attemptId`, `cwd`, 준비 때의 `headSha`, `text`, `tokens`, `proof`, 관측 결과가 있다.
- `epoch`: 이 시도를 시작한 프로젝트 초기화 번호다.
- `signal`: 이 시도의 중단 신호다. 취소·임대 갱신 실패 때 중단된다.
- `messages`: 이번 실행 지시문에 넣은 메시지의 목록이다.

`fence`는 낡은 Runner의 보고를 막는 번호표다.
`headSha`는 커밋 하나를 정확히 가리키는 고유 번호다.
`proof`는 프로세스 종료를 확인한 증거다.
`output.text`는 Claude의 최종 result 글 또는 마지막 주 Agent 메시지다.
Codex는 마지막 주 Agent 메시지를 사용한다.
이 글은 아직 신뢰할 수 없는 원문이다.
왜: CLI가 정상 종료했어도 결과 형식이나 내용이 잘못되었을 수 있다.

### ①을 연결하는 위치

`taskCheck(context)`는 `dev`와 `rework`에서만 호출한다.
CLI와 자손의 종료를 확인하고 서버에 물리 슬롯을 반환한 뒤 호출한다.
로컬 세션 보유도 이때 제거한다.
Task의 논리 잠금과 임대 갱신은 유지한다.
왜: 검사 명령이 새 슬롯을 얻어야 하지만 다른 작업이 같은 Task를 가져가면 안 된다.

M5-05에서 `taskCheck`가 없으면 ① 자리표시로 진행한다.
서버는 기존 자리표시 경로를 사용하고 job의 `finished` 사건에 `taskCheckPlaceholder:true`를 남긴다.
실제 CI(자동 검사) 성공 기록을 만들지는 않는다.
M7-06은 `taskCheck`에서 실제 ①을 실행하고 서버에 기록해야 한다.
같은 시도 안의 수정과 검사 명령은 기존 `Execution.command()`를 사용한다.
`{id:job.id,fence:job.fence,epoch}`를 그대로 전달한다.
왜: 이 경로가 공유 무거운 작업 번호표와 `slots/acquire → process → slots/release`를 지킨다.

검사·수정 중에는 `signal`을 전달한다.
최종 검사가 끝나기 전에는 `taskCheck`가 반환하면 안 된다.
실패가 해결되지 않으면 오류를 던진다.
현재 실행기는 시도를 중단하고 종료 증거를 확인해 보유를 해제한다.
QA 결과와 다음 QA job은 만들지 않는다.

### 결과 수집과 나가는 값

`collect(context)`는 반드시 제공한다.
반환값은 `{report,responses?}`다.

- `report`: 생성 클라이언트의 `reportAttemptResult` 요청 본문에서 `fence`만 뺀 값이다.
  공통 필드는 `summary`, `changedFiles`, `evidence`다.
  검증 시도는 `verification`을 포함한다.
- `responses`: 이번에 전달한 메시지에 대한 Agent의 실제 업무 응답이다.
  각 항목은 `{messageId,text,workState}`다.
  이번에 전달하지 않은 ID와 중복 ID는 거부한다.

`collect`는 contracts §5의 Agent 출력 스키마 검사와 형식 오류 1회 수정 요청을 완료해야 한다.
개발 변경 파일은 Agent의 자기보고가 아니라 기존 Git 계층으로 관측해야 한다.
Evidence(검증 증거 파일)는 기존 업로드 계약으로 먼저 올리고 ID를 반환해야 한다.
QA는 검사한 `headSha`·`specRevision`·입력 버전을 고정해야 한다.
QA 종료 때 코드 변경과 작업 폴더의 청결도 다시 확인해야 한다.
왜: 원문을 그대로 API 결과로 보내면 Agent가 실제로 확인하지 않은 코드가 통과할 수 있다.

M5-05는 이 수집기를 호출하는 경계까지 제공한다.
실제 Git·Evidence·Agent 출력 수집기는 자동으로 연결하지 않는다.
시나리오의 수집기는 가짜 CLI가 낸 고정 자료만 읽는 시험 공급원이다.

수집이 끝나면 메시지 업무 응답을 먼저 보낸다.
이어서 `POST /api/runner/attempts/:attemptId/result`를 보낸다.
`fence`는 원래 job의 값으로 넣는다.
보고는 기존 outbox(디스크에 저장하는 발송함)에 먼저 저장한다.
응답을 잃으면 같은 멱등 키와 본문으로 재전송한다.
왜: 서버가 이미 처리한 결과를 새 결과로 한 번 더 만들면 안 된다.

결과 API의 성공 응답은 `201`이며 본문은 없다.
`runNext`의 반환값도 최종 Task 상태가 아니라 처리한 job이다.
Task 상태와 다음 job 생성은 서버의 결과 처리 트랜잭션이 정한다.
Gate 도달 여부는 기존 Task 조회나 서버 변경 사건으로 확인한다.
`integrate` job은 이 흐름이 예약하지 않는다.
M7-06은 Gate 뒤의 별도 처리기로 ②·병합·완료를 이어야 한다.

### 사건 순서

1. `claimJob`으로 예약한다. 아직 시도는 없다.
2. 시작 직전에 `Runner.poll()`로 메시지와 정책을 다시 받는다.
3. `Execution`이 등급·작업 폴더·하위 Agent를 준비한다.
4. `startJob → reportAttemptStatus(running) → reportJobProcess`를 따른다.
5. 실제 CLI 출력이 시작된 뒤 이번 메시지만 `ackMessage`로 확인한다.
6. 그룹 종료 → `releaseJobSlots` → `taskCheck`(개발·재작업만) → `collect`를 따른다.
7. `respondMessage → reportAttemptResult`를 따른다.
8. 서버가 `finished` 사건과 Task 변경 사건을 남긴다. 다음 QA·재작업 job도 서버가 만든다.

ack는 받았다는 확인이다.
업무 완료나 Task 완료를 뜻하지 않는다.
실행 중 새로 온 지시는 현재 지시문에 추가하지 않는다.
다음 같은 Task·같은 Agent 실행에서 전달한다(Q-07).
왜: 실행 중 즉시 전달 기능이 승인되거나 지원된 것처럼 표시하면 안 된다.
시작 전 메시지·정책 조회가 실패하면 시도를 만들지 않는다.
초기화 세대가 그대로면 job을 실패 처리하고 `no_process`로 보유를 해제한다.
초기화가 진행 중이면 기존 초기화 정리가 해제를 맡는다.
왜: 조회 실패로 실행하지 못한 예약이 무거운 작업 자리를 계속 차지하면 안 된다.

## M5-04의 프로세스 없는 job 종료

내보낸 함수 `finishJob(options, job, {status,result?,error?})`는 API의 `finishJob` 뒤 `releaseJob`을 보낸다.
`options`에는 `api`, 기존 `runner`, `epoch()`와 `identity`만 필요하다.
Planning 호출자는 시도용 `collect`나 `Execution`을 만들 필요가 없다.
해제 증거는 `{kind:'no_process',bootId}`다.
서버 보유의 epoch·host·boot·fence가 현재 값과 같아야 한다.
서버에 pgid(프로세스 그룹 번호)나 cgroup(커널의 프로세스 묶음)이 있으면 거부한다.
왜: 단순 종료 통보만 보내면 끝난 Planning job의 무거운 작업 슬롯이 남고, 실행 중인 프로세스를 없는 것으로 보고해서도 안 된다.

이 기준 브랜치에는 M5-04 `src/planning`이 없다.
해당 처리기를 결합할 때 기존 API의 `finishJob` 직접 호출을 이 함수로 연결한다.
`stop_attempt`에는 서버 보유가 없으므로 `finishJob`만 보낸다.
중단 명령의 완료는 대상 실행의 그룹 정리가 끝난 뒤 보고한다.
`startJob` 응답을 기다리는 동안 도착한 중단도 보관한다.
응답으로 시도 ID를 받은 뒤 CLI 실행 허가 전에 그 중단을 반영한다.
왜: 서버에서는 이미 시작한 시도인데 Runner의 응답만 늦었다는 이유로 중단을 놓치면 안 된다.

## 확인 명령

`pnpm -C agent-wbs test:scenario -- attempt-flow`

전용 테스트 DB(데이터베이스)의 `TEST_DATABASE_URL`을 지정한다.
fake CLI와 실제 로컬 프로세스를 사용한다.
시나리오 6은 Gate 대기까지만 확인한다.
시나리오 7은 running·qa·verifying 각각을 확인한다.
시나리오 9는 재부팅 보고와 보유 대조 뒤 같은 등급의 새 시도를 확인한다.
재부팅 자체는 서버의 bootId 변경으로 재현한다.
운영체제나 실제 Claude·Codex·GitHub·SMTP·Telegram은 호출하지 않는다.
