# 시도 흐름 결합(M5-05)

`AttemptFlow`는 서버가 예약한 시도 하나를 `Execution`에 넘긴다.
개발 → ①(Task 검사) → QA(검증 Agent의 검사) → 재작업 → 재검증 → Gate 대기까지 잇는다.
Gate는 완료 전에 통과해야 하는 조건 묶음이다.
다음 시도의 종류와 등급, 재시도 횟수는 서버가 정한다.
왜: Runner마다 판정하면 같은 결과를 보고도 다음 작업이 달라질 수 있다.
API는 프로그램끼리 요청하고 응답하는 약속이다.
기본 용어는 [프로젝트 용어집](../../../docs/glossary.md)을 함께 참고한다.

기준은 `docs/plan/contracts.md` §3.5·§4.1·§5, owner Q-04·Q-05·Q-07, 가이드 시나리오 6·7·9다.
M7-06의 실제 ①을 `bindTaskCheck`로 연결한다.
②(통합 확인)·GitHub 병합·`done`은 별도 CI 처리기가 맡는다.
실제 실행은 격리 공급원이 없으면 계속 거부한다.
시험의 `fake-only` 격리와 결과 수집기는 실제 실행에 쓰면 안 된다.
왜: 시험용 결과는 실제 코드나 Agent 출력을 검증하지 않는다.

## 사용하는 방법

`RunnerAppDeps.execution`에 기존 작업 폴더 준비와 격리 공급원을 연결한다.
`RunnerAppDeps.jobs`에 `collect`와 실제 `taskCheck`를 반드시 연결한다.
실제 `taskCheck`는 ① 공급원(`TaskCheckSources`: `repo`·`worktree`·`launch`·`collectTests`·`observeMainPipeline`)으로 넘긴다.
앱(`RunnerApp`)이 자기 GitHub 클라이언트·`Execution`·`Runner`·API로 `bindTaskCheck`를 부른다.
GitHub 설정이 없으면 `github: null`로 묶는다(PR 없이 보고, 서버가 통합을 보류).
왜: GitHub 클라이언트는 배포 키 검사·권한 거부 보고·토큰 무효화가 걸린 앱의 것 하나만 써야 한다. 밖에서 다른 클라이언트를 넘기면 PR 생성이 그 관문을 지나지 않는다.
함수를 직접 넘기는 모양은 시험용이다.
`taskCheck`가 없으면 구성 단계에서 거부한다.
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
claim과 run은 같은 `canStart` 함수에 `1 + 해당 역할의 하위 Agent 예산`을 전달한다.
예약 전에는 가능한 Agent·역할 조합을 검사한다.
서버가 실제로 고른 조합도 같은 인자로 다시 검사한다.
왜: 1칸으로 예약한 뒤 3칸이 필요하다는 이유로 시작하지 못하면 안 된다.

`poll`의 비동기 오류는 `onError`로 전달한다.
앱은 인증 실패 때 전체 실행을 멈춘다.
나머지는 경고로 남긴다.
`runNext`와 `run`은 오류를 호출자에게 돌려준다.

## 연결 지점(다음 작업: `collect`·`execution.prepare`)

지금 `main.ts`는 시도 흐름(`jobs`)을 켜지 않는다(조정자 답변 2026-11-27).
왜: 실제 결과 수집기 `collect`와 시도별 작업 폴더 준비 `execution.prepare`가 아직 없다.
둘을 만들면 `main.ts`의 `new RunnerApp({...})`에 아래 두 값만 더하면 된다. 나머지(격리·scope·①·GitHub 클라이언트·CI)는 이미 연결돼 있다.

```ts
new RunnerApp({
  // …지금 값 그대로…
  execution: { prepare },                    // 1) 시도별 작업 폴더
  jobs: { collect, taskCheck: sources },     // 2) 결과 수집기 + ① 공급원
});
```

### 1) `execution.prepare(job) → { cwd, headSha }`

- 타입: `ExecutionOptions['prepare']`(`src/exec/session.ts`). `job`은 생성 클라이언트의 `attempt` job(`AttemptJob`)이다.
- 부르는 곳: `Execution.run`이 등급(`getRunGrade`)을 받은 뒤, 하위 Agent 설치·`startJob` 전에 한 번 부른다.
- 해야 할 일:
  - 앱의 `GitRepository`(`GitRepository.open(home, repositoryId, { agentRoot })`)로 작업 폴더를 만든다: `createWorktree(<작업 폴더 id>, <로컬 agent 브랜치>, job.payload.baseCommit)`.
  - 전용 계정 배치면 작업 폴더가 `/srv/agentwbs/worktrees/<저장소>/<id>` 아래에 0770으로 생긴다. 래퍼가 이 밖의 `--cwd`는 거부한다.
  - `cwd`는 그 작업 폴더의 절대 경로, `headSha`는 그 폴더의 현재 커밋(전체 SHA)이다.
  - 같은 Task·역할의 재개(`resume`)는 같은 `cwd`일 때만 CLI 세션을 이어 간다(`Execution`이 비교한다). 그래서 재작업은 같은 작업 폴더 id를 써야 한다.
- 실패하면 예외를 던진다. `Execution`이 시작 전 실패로 처리한다(`finishJob(failed)` + `releaseJob(no_process)`).

### 2) `jobs.collect(context) → { report, responses? }`

- 타입: `AttemptFlowOptions['collect']`(`src/jobs/attempt-flow.ts`). `context`는 `AttemptContext`(`job`·`output`·`epoch`·`signal`·`messages`)다.
- 부르는 곳: CLI와 자손 종료 확인 → 물리 슬롯 반환 → (dev·rework만) ① 통과 뒤. 같은 임대·같은 중단 신호 안이다.
- 돌려줄 값: 아래 「결과 수집과 나가는 값」 절 그대로(`report`는 `reportAttemptResult` 본문에서 `fence`만 뺀 값).
- 해야 할 일(contracts §5): Agent 종료 JSON의 스키마 검사, 형식 오류면 1회 수정 요청(같은 작업 폴더에서 CLI를 한 번 더 — `Execution`을 거쳐야 한다), 변경 파일은 git diff, Evidence는 업로드 뒤 ID.

### 3) `jobs.taskCheck`: ① 공급원 `TaskCheckSources`

- 함수가 아니라 공급원 객체를 넘긴다. 앱이 자기 GitHub 클라이언트·`Execution`·`Runner`·API로 `bindTaskCheck`를 부른다.
- `repo`: 1)과 같은 `GitRepository`.
- `worktree(context)`: 1)에서 만든 작업 폴더의 `{ id, branch }`.
- `launch(argv, cwd)`: `ciLaunch(argv, cwd, env)`(`src/ci/launch.ts`)를 그대로 쓴다. 전용 계정이면 `Execution.command`가 래퍼 `ci-run`으로 감싼다.
- `collectTests`: **생략한다.** 생략하면 `bindTaskCheck`가 이 시도의 job으로 묶인 실행기(`Execution.command`)로 `createTestCollector`(`src/ci/collect-tests.ts`)를 쓴다.
  - 왜: 목록 명령도 Agent 코드(시험 설정)를 실행하므로 같은 job의 슬롯·보유·격리(래퍼 `ci-run`)로 돌아야 한다. 시험만 가짜 수집기를 넣는다.
- `observeMainPipeline`: 고정한 main의 파이프라인 정의를 입력 관측 API로 보고한다(CI 처리기의 `#observe`와 같은 일).

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

`jobs/task-check.ts`의 `bindTaskCheck`는 M7-06의 `runTaskCheck`를 사용한다.
자리표시나 ① 기록 없는 QA 인계는 없다.
왜: 검사하지 않은 개발 결과가 QA로 넘어가면 검증 근거가 끊어진다.

연결할 공급원은 다음과 같다.

- `repo`: 기존 `GitRepository`다.
- `worktree(context)`: 준비한 작업 폴더의 등록 ID와 로컬 Agent 브랜치를 돌려준다.
- `launch(argv,cwd)`: main에 고정한 검사 명령을 명령·인자 배열로 만든다. 허용된 환경 변수만 넣는다.
- `collectTests`: M7-06 계약대로 실제 테스트 식별자를 수집한다.
- `observeMainPipeline`: 고정한 main의 파이프라인 정의를 기존 입력 관측 API로 보고한다.
- `execution`, `runner`, `api`: 앱이 공유하는 기존 인스턴스다.

검사 명령은 `Execution.command()`를 거친다.
원래 `job.id`·`job.fence`·`epoch`와 중단 신호를 그대로 사용한다.
`runTaskCheck`가 공유 HeavySemaphore(무거운 작업 번호표)를 이미 잡았으므로 어댑터는 `{heavyHeld:true}`를 전달한다.
다른 명령 호출자는 이 값을 생략한다.
왜: 상한이 1일 때 같은 번호표를 두 번 기다리면 서로 기다리며 멈춘다.

어댑터는 `startCiRun → updateCiRun(run) → updateCiRun(pass/fail)`을 같은 attemptId·fence로 보고한다.
검사한 `baseSha`·`headSha`·`pipelineSha`와 단계별 결과도 함께 보낸다.
통과한 커밋만 서버가 기록한 `job.payload.branch`로 push한다.
왜: 검사한 코드와 다음 QA가 받는 코드를 같게 유지해야 한다.

`taskCheck`는 `TaskCheckResult`를 돌려준다.
`failScope`와 실패 단계의 실제 종료 코드로 실패를 분류한다.
근거가 없으면 Task 코드 실패로 추측하지 않는다.

| 실제 결과 | 시도·Task | 다음 동작 |
| --- | --- | --- |
| Task 명령의 0이 아닌 종료 코드 또는 보호 경로 위반 | failed·rework | 서버가 자동 재작업을 만들고 재작업 횟수에 센다 |
| `failScope=baseline` | interrupted·paused | 재작업 횟수를 늘리지 않고 같은 종류·등급으로 재개한다 |
| 환경·명령 실행·수집 오류 또는 `collect` 실패 | interrupted·paused | 종료 증거를 확인한 뒤 보유를 닫고 재개를 기다린다 |

이 분류는 조정자 결정 `coord-decisions.md`의 3번을 따른다.
왜: 기준 환경의 고장을 Task 코드 실패로 세면 안 된다.
서버도 같은 시도에 저장한 최신 ① 실패 기록을 확인한다.
Runner의 `failure` 문자열만으로 ① 실패 재작업을 허용하지 않는다.
실패한 ①은 QA 결과를 만들지 않는다.
세션용 하위 Agent 파일은 실행이 끝난 뒤 소유 hash(파일 내용을 식별하는 값)를 확인해 정리한다.
정리되지 않은 사용자 파일을 무시하거나 삭제하지 않는다.
왜: Runner가 만든 설정 파일 때문에 깨끗한 코드 검사가 실패해서도 안 되고, 사용자 변경을 숨겨서도 안 된다.

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
시나리오의 수집기는 가짜 CLI의 고정 결과와 실제 Git 변경 목록을 사용하는 시험 공급원이다.
작업 폴더가 깨끗한지도 실제 Git으로 확인한다.

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
실패·중단된 시도에 ack한 지시는 `runner.json`의 `instructions`에 시도 ID와 함께 보관한다.
다음 같은 Task·Agent 실행의 첫 입력에 「이전 시도에서 받은 지시」로 묶고 다시 ack한다.
재시작 뒤에도 이 기록을 읽는다.
왜: 받았다는 확인만 남기고 지시가 조용히 사라지면 안 된다.
성공한 개발 결과나 QA PASS가 서버에서 확인된 뒤에만 지시를 지운다.
결과 응답을 잃고 재시작했으면 기존 outbox의 성공 재전송이 이 정리를 마친다.
QA FAIL·BLOCKED는 성공으로 처리하지 않는다.
초기화는 이전 프로젝트의 보관 지시도 지운다.
이 동작은 조정자 결정의 4번을 따른다.

시작 전 자원 검사가 부족을 알리면 `returnJob`으로 같은 job을 서버 대기열에 돌려준다. 프로세스와 시도가 없는지 서버가 다시 확인한다.
claim 직후에는 기본 20초 동안 같은 임대로 기다린다. 그래도 부족하면 반환한다. 반환한 뒤에는 `claim()`이 `null`을 돌려준다.
논리 잠금과 현재 fence(낡은 Runner의 보고를 막는 번호표)는 유지한다. 다음 claim은 새 fence를 받는다. 재시도 횟수는 쓰지 않는다.
왜: 짧은 자원 경합 때문에 자동 QA·재작업을 팀장이 다시 시작하지 않게 한다.
서버는 연속 반환 뒤 1·2·4초를 기다린다. 4번째부터는 자원 부족 경보를 열고 같은 job을 5분 보류한다. 다른 실행 가능한 job은 계속 받는다.
실제 시작에 성공하면 반환 횟수와 경보를 해소한다. PC 변경으로 닫힌 보유는 새 claim에서 재사용하지 않는다.
job이 완료·실패·취소로 끝나도 자원 부족 경보는 해소한다. 대기 중 Agent를 바꾸면 다음 claim은 새 Agent의 payload와 보유를 받는다.
왜: 한 Agent의 문제로 대기열 전체가 굶거나, 과거 보유를 덮어쓰는 일이 없어야 한다.
시작 전 정책·메시지·등급·하위 Agent 조회, 작업 폴더 준비, 종료 신호가 실패하면 시도를 만들지 않는다.
초기화 세대가 그대로면 job을 실패 처리하고 `no_process`로 보유를 해제한다.
초기화가 진행 중이면 기존 초기화 정리가 해제를 맡는다.
왜: 조회 실패로 실행하지 못한 예약이 무거운 작업 자리를 계속 차지하면 안 된다.
서버에 실제 시도나 pgid·cgroup이 있으면 이 시작 전 경로로 해제하지 않는다.
왜: 서버 응답을 잃었다는 이유만으로 프로세스를 만들지 않았다고 보고하면 안 된다.

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
