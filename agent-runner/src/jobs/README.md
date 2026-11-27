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

## 켜는 방법(main.ts, 기본 꺼짐)

`main.ts`는 `.env`에 `AWBS_ATTEMPT_AUTO=1`이 있을 때만 시도 흐름(`jobs`)을 켠다.
왜: 켜면 실제 Claude·Codex 호출(유료)이 시작된다. M8 실호출 전까지는 owner가 정할 때만 켠다(CI 자동 `AWBS_CI_AUTO`와 같은 방식).
`AWBS_GITHUB_REPO`도 필요하다.
왜: 작업 폴더를 만들 로컬 저장소(clone)를 그 주소로 찾는다(`repositoryIdFor`).

켜면 `attemptWiring`(`wiring.ts`)이 만든 두 값을 `new RunnerApp({...})`에 더한다.

```ts
new RunnerApp({
  // …지금 값 그대로…
  ...attemptWiring({ home, agentRoot, repoUrl, api, epoch, warn, env }),
  // = execution: { prepare }        1) 시도별 작업 폴더(workspace.ts)
  //   jobs: { collect, taskCheck, settle }  2) 결과 수집 공급원(collect.ts) + ① 공급원 + 보고 뒤 정리
});
```

- `collect`와 `taskCheck`에는 공급원(객체)만 넘긴다.
- 앱이 자기 `Execution`·`Runner`·API(①은 GitHub 클라이언트까지)로 `bindCollect`·`bindTaskCheck`를 부른다.
  - 왜: 공유 인스턴스가 둘이면 슬롯·보고·관문이 어긋난다. 함수를 직접 넘기는 모양은 시험용이다.
- 저장소는 처음 쓸 때 연다.
  - 로컬 clone이 아직 없으면(초기 분석 전) 준비가 실패한다.
  - 그러면 시도를 만들지 않고 job을 실패로 끝낸다(시작 전 실패, `finishJob(failed)` + `releaseJob(no_process)`).
- 격리 계층이 없으면(전용 계정 미설치·점검 실패) 켜져 있어도 claim하지 않는다(`Execution.claim`).

## 작업 폴더 규칙(`workspace.ts`, `execution.prepare`)

작업 폴더는 Task 브랜치(`job.payload.branch`)마다 두 개다.
이름에는 브랜치 이름의 SHA-256 앞 20자리를 쓴다.
왜: 초기화로 세대가 바뀌면 브랜치 이름도 바뀌므로 옛 세대 폴더와 섞이지 않는다.

- **개발 폴더**(`w-<hash>-dev`): dev·rework가 쓴다.
  - 있으면 그대로 다시 쓴다. 커밋하지 않은 파일도 지우지 않는다.
  - 왜: 재시도·재작업이 중단된 작업을 이어 가야 한다. CLI 세션 재개도 같은 cwd일 때만 이어진다(`Execution`이 비교한다).
  - 없으면 새로 만든다. dev는 `job.payload.baseCommit`에서, rework는 원격 Task 브랜치(①을 통과해 push된 커밋)에서 시작한다.
  - rework인데 원격 브랜치를 읽지 못하면 실패한다. 시작점을 추측하지 않는다.
  - 기록은 있는데 폴더가 사라졌으면 기록을 정리하고 다시 만든다.
- **검증 폴더**(`w-<hash>-qa`): qa·reverify가 쓴다.
  - 매번 지우고 ①이 검사한 커밋으로 새로 만든다.
  - 검사한 커밋은 ①이 가져온 결과(`refs/agent-results/<개발 폴더>`)다. 없으면 원격 Task 브랜치다.
  - 왜: QA는 검사한 코드 그대로에서 시작해야 한다(contracts §4.1 「코드 근거 고정」 1). 경로는 같으므로 재검증도 같은 cwd다.
- 서버가 준 입력 커밋을 Runner 저장소가 아직 모르면 원격 main을 먼저 받는다(`fetch`).
- **입력 사본**: 입력 커밋의 `prototype/`을 읽기 전용 사본(`inputs/<저장소>/in-v<입력 버전>-<커밋 12자리>`)으로 만든다.
  - 이미 있으면 다시 쓴다. `prototype/`이 없는 커밋이면 만들지 않는다.
  - 위치는 지시문 끝 「[Runner 안내]」에 적는다(`prepare`가 돌려주는 `notes`).
- 폴더 만들기는 모두 `GitRepository.createWorktree`가 한다.
  - 전용 계정 배치는 Runner 전용 준비 폴더(`.prep-<uuid>`, 0700)에서 clone → remote remove → checkout을 끝낸다.
  - 그 뒤 0770으로 바꿔 제자리로 옮긴다(조정자 결정 6). 넘긴 뒤 Runner git은 그 폴더에서 돌지 않는다.
  - 폴더의 HEAD는 Agent 계정 git(래퍼 `git-inspect`)으로만 본다(`worktreeHead`).
- 하위 Agent 정의 파일은 이 준비 뒤 `Execution`이 래퍼 `agent-file`(Agent 계정)로 넣는다.
- ① 공급원의 `worktree(context)`는 개발 폴더의 `{ id, branch }`다. 로컬 Agent 브랜치는 `agent/<폴더 이름>`이다.

정리(`settle`)는 결과 보고를 서버가 받아들인 뒤에 한다.

- qa·reverify: 검증 폴더를 지운다.
- 판정이 PASS면 개발 폴더도 지운다. 다음 재작업(② 실패 등)은 원격 Task 브랜치에서 다시 만든다.
- dev·rework: 지우지 않는다. QA FAIL 뒤 재작업이 같은 폴더를 쓴다.
- 왜 보고 뒤인가: 보고 전에 지우면, 응답을 잃고 다시 시작할 때 검사한 커밋을 다시 볼 수 없다.
- 정리 실패는 경고로만 알린다(`onError`). 남은 폴더는 다음 준비나 초기화 정리(`reset`)가 다시 지운다.
- 알려진 한계: Task가 `done`이 되거나 취소될 때 남은 개발 폴더를 지우는 연결은 아직 없다. 초기화 정리가 지운다.

## 결과 수집(`collect.ts`, `output.ts`)

`collect(context)`는 아래 순서로 일한다.

1. 종료 메시지를 JSON Schema로 검사한다(contracts §5).
   - 전체가 JSON이거나, 마지막 `json` 코드 블록이어야 한다. 다른 모양은 추측하지 않는다.
   - 의미 검사도 한다. 업무 응답은 이번에 전달한 메시지에만 쓸 수 있다.
   - QA 항목은 서버가 준 체크리스트 키로만, 모든 항목을 한 번씩 보고해야 한다. PASS이면 모든 항목이 PASS여야 한다.
2. 맞지 않으면 **같은 세션에 한 번만** 수정 요청을 보낸다(`Execution.followUp`).
   - 같은 job·fence·임대다. 물리 슬롯을 다시 받고(`acquireJobSlots`) 프로세스를 등록한 뒤, 끝나면 종료 증거로 반환한다.
   - 왜: 슬롯을 반환한 뒤 서버 보유 없이 프로세스를 띄우면 PC 자리 계산과 정리 대조가 어긋난다.
   - 세션 ID가 없으면 수정 요청을 보낼 수 없다. 새 세션을 열지 않는다.
   - 수정 요청 세션은 하위 Agent 정의 없이 돈다. 첫 실행이 끝날 때 이미 걷어 냈기 때문이다.
3. 수정 요청 뒤에도 틀리면 역할에 따라 다르게 끝낸다.
   - dev·rework: `failure`(`Agent 종료 메시지 형식 오류(…)`)로 보고한다. 서버가 실행 실패로 세고 자동 재시도 규칙을 적용한다.
   - qa·reverify: 판정을 지어내지 않고 멈춘다(`CollectError`, 시도는 interrupted). 서버가 QA 결과에 `failure`를 받지 않기 때문이다.
4. 개발: 변경 파일은 Agent 자기보고가 아니라 Runner bare 저장소의 git diff다(`changedPaths`).
   - 이름 변경은 옛 경로와 새 경로를 모두 넣는다.
   - 입력은 ①이 래퍼 `git-bundle`로 가져와 검사·push한 결과 커밋(`resultHead`)이다. 다시 가져오지 않는다.
   - 왜: 검사한 커밋과 보고하는 커밋이 같아야 한다.
   - 수정 요청을 보냈으면 폴더의 HEAD·청결을 Agent 계정 git으로 다시 본다. 바뀌었으면 검사하지 않은 코드이므로 멈춘다.
5. 검증: `headSha`는 준비 때 고정한 커밋, `specRevision`은 지시문의 명세 버전(`instructions.revision`)이다.
   - 끝난 폴더의 HEAD·청결을 Agent 계정 git으로 다시 본다(`taskCheckPath`). 다르거나 더러우면 멈춘다.
   - 체크리스트는 서버가 qa·reverify job의 지시문(`instructions.checklist`)에 준 키만 쓴다.
6. Evidence: 검증한 종료 메시지와 Runner 관측(headSha·변경 파일 등)을 JSON 파일 하나로 먼저 올리고(`uploadEvidence`), 그 ID를 보고한다.
   - 종류는 `dev-report`·`qa-report`·`agent-output-invalid`다.
   - Agent가 폴더에 만든 증거 파일은 아직 올리지 않는다. 경로만 체크리스트 메모에 「Agent가 적은 근거」로 남긴다.
   - 왜: Runner 계정이 Agent가 쓸 수 있는 폴더의 파일을 읽으면 링크를 통해 Runner 파일이 새어 나갈 수 있다. Agent 계정으로 읽는 길은 다음 작업이다.

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

실제 수집기는 위 「결과 수집」의 `bindCollect`다.
기존 시나리오(`attempt-flow.scenario.test.ts`)의 수집기는 가짜 CLI의 고정 결과와 실제 Git 변경 목록을 쓰는 시험 공급원이다.
실제 연결 시나리오는 `attempt-wiring.scenario.test.ts`다.

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

`pnpm -C agent-wbs test:scenario -- attempt-wiring`

`attempt-wiring`은 실제 `attemptWiring`(작업 폴더 준비·결과 수집·①)으로 claim → prepare → 세션 → ① → collect → QA → ② → 병합 → done을 돈다.

- 같은 계정 배치 다섯 경우: 끝까지, 형식 수정 요청 1회, 수정 뒤에도 틀림, QA가 폴더를 더럽힘, QA FAIL → 재작업 → 재검증.
- 전용 계정 배치(host) 한 경우: 래퍼와 사용자 scope로 같은 흐름을 돈다.
  - 설치된 래퍼가 저장소 래퍼와 같으면 실제 Agent 계정(awbs-agent)으로 돈다.
  - 다르면(owner가 새 래퍼를 설치하기 전) 새 래퍼 사본과 같은 계정 fake sudo로 돈다. 계정 전환만 대신한다(`dedicated-scope.host.ts`와 같은 방법).
- fake CLI(`test/fakes/agent-cli.mjs`)는 실제로 파일을 바꾸고 커밋한다. 전용 계정에서는 래퍼 `ci-run`(고정 PATH의 node)으로 뜬다.
  - 왜: 래퍼 `run`은 실제 Claude·Codex 진입점만 받는다(조정자 결정 4).

전용 테스트 DB(데이터베이스)의 `TEST_DATABASE_URL`을 지정한다.
fake CLI와 실제 로컬 프로세스를 사용한다.
시나리오 6은 Gate 대기까지만 확인한다.
시나리오 7은 running·qa·verifying 각각을 확인한다.
시나리오 9는 재부팅 보고와 보유 대조 뒤 같은 등급의 새 시도를 확인한다.
재부팅 자체는 서버의 bootId 변경으로 재현한다.
운영체제나 실제 Claude·Codex·GitHub·SMTP·Telegram은 호출하지 않는다.
