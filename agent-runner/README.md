# Agent Runner

최초 공개키 생성과 서버 CLI 승인은 [Runner GitHub 등록 안내](../docs/runner-github-setup.md)에 있다.

시도 실행과 M7-06의 연결 계약은 [시도 흐름 결합(M5-05)](src/jobs/README.md)에 있다.

개발 PC에서 Agent WBS에 연결하는 상주 프로그램이다. 앱 시작 뒤 서버 동기화·보유 대조·준비 점검을 마치면 아래 job을 받는다. Claude·Codex CLI 실행 인자·출력 해석·환경 변수 allowlist는 [src/cli/README.md](src/cli/README.md)에 있다.

## 작업 수신과 켜짐 조건

계약의 14종을 서버 발급 코드와 대조했다. `QueuedJobs`와 기존 `Execution`·`CiJobs`가 앱의 예약 반복에서 claim한다.

| job | 서버 발급 위치 | claim·실행·보고 | 켜짐 조건 |
|---|---|---|---|
| `repo_check` | `project/service.ts` 저장소 확인 | QueuedJobs → GitHub `checkRepository` → repo 결과·finish | GitHub 저장소 설정 시 기본 켜짐 |
| `github_check` | `settings/routes.ts` 연결 확인 | QueuedJobs → 연결 확인 → jobId·fence 포함 GitHub 보고(서버가 job 종료) | 위와 같음 |
| `bootstrap` | `project/service.ts`, `project/jobs.ts` 등록·확정·재시도 | QueuedJobs → runPlanningJob → progress·기술 제안·초안·finish | Planning 자동 |
| `input_diff` | `project/service.ts`, `project/jobs.ts` 입력 분석·재시도 | QueuedJobs → runPlanningJob → progress·CP·finish | Planning 자동 |
| `planning` | `planning/jobs.ts`, `planning/sessions.ts` 재판단·세션·CP 판단 | QueuedJobs → runPlanningJob → planning API·finish | Planning 자동 |
| `estimate` | `planning/estimate.ts` 추정·등급 재판단 | QueuedJobs → runPlanningJob → 추정·등급·finish | Planning 자동 |
| `split` | `planning/split.ts` 분할 요청 | QueuedJobs → runPlanningJob → 분할 CP·finish | Planning 자동 |
| `attempt` | `runner/service.ts` 수동·자동 시도 | AttemptFlow → Execution.claim·run → status·결과·해제 | `AWBS_ATTEMPT_AUTO=1` |
| `stop_attempt` | `runner/routes.ts` 중단 요청 | AttemptFlow → Execution.claim·stop → interrupt·해제 | 위와 같음 |
| `integrate` | `execution/gate.ts` 통합 조건 통과 | CiJobs → IntegrationQueue → CI·병합 대기열 보고 | `AWBS_CI_AUTO=1` |
| `ci_retry` | `ci/routes.ts` CI 다시 실행 | CiJobs → task/int 검사 → CI·finish | 위와 같음 |
| `deploy_check` | `ci/routes.ts` 배포 확인 | QueuedJobs → runDeployCheck → CI·finish | 위와 같음 |
| `design_apply` | `design/service.ts` 계약에 반영 | QueuedJobs → 대상 조회·격리 CLI·파일 대조·시스템 push → snapshot·finish | Planning 자동 + 시스템 배포 키 |
| `merge_followup` | 계약에 예약됨, 현재 발급 코드 없음 | QueuedJobs → PR 병합·main 이력 확인 → snapshot·finish | CI 자동 |

무료 확인은 GitHub 조회만 하므로 기본 켜짐이다. `AWBS_GITHUB_REPO=https://github.com/<owner>/<repo>`는 인증과 작업 저장소의 기준이다. 저장소 확인은 버튼이 넘긴 URL을 따로 확인하되, 설정과 다른 저장소이면 등록을 막는 이유도 보고한다. 연결 확인은 요청의 인증 방식(gh/token)을 반영한다. GitHub 설정이 없으면 위 수신은 시작하지 않는다.

Planning 자동은 `AWBS_PLANNING_AUTO=1`, `AWBS_PLANNING_CODEX_MODEL`, `AWBS_PLANNING_CLAUDE_MODEL`, 확인된 Agent 격리, 남은 호출 예산이 모두 있어야 켜진다. 기본은 꺼짐이다. `AWBS_ATTEMPT_AUTO`의 기존 시도 흐름 의미는 그대로이며, CI 자동에는 배포 확인 수신도 포함한다. 두 기존 플래그로 Planning이 켜지지는 않는다.

## 유료 호출 상한

- `AWBS_AGENT_CALL_LIMIT`: 기본 **0회**, owner가 정하는 검증 전체 예산 **0~30회**. `AWBS_AGENT_MAX_EFFORT`: 기본 **high**, low·medium·high만 허용한다. 상한을 넘는 등급은 실행하지 않는다.
- Planning·계약 반영·시도·형식 수정 요청이 같은 `PaidCalls`를 쓴다. 실행 전에 `AWBS_HOME/paid-calls.json`에 사용 순번을 동기화한다. 시작 실패·중단도 소비하며, 재시작·프로젝트 초기화로 횟수가 돌아오지 않는다. 이 파일을 지우거나 새 홈으로 한도를 우회하지 않는다.
- 하위 Agent는 끈다. 시도에 하위 Agent 정의가 켜져 있으면 실행을 거부한다. 별도 유료 세션을 장부 밖에서 만들지 않기 위해서다. 횟수는 돈의 총액 제한이 아니다.
- 한도가 소진되면 새 유료 job을 받지 않는다. 처리 중 소진되면 해당 단계 실패를 보고한다. 무료 저장소·연결 확인은 계속한다.

작업 기록은 `state/queued-jobs/job.json`, Planning의 단계·전송 기록은 `state/planning/`에 둔다. 보고는 먼저 기록하고 같은 멱등 키로 보낸다. 임대를 15초마다 연장하며 만료 5초 전에 멈춘다. 모든 push는 서버의 외부 쓰기 권한과 현재 fence를 확인하는 기존 관문을 거친다. Agent 작업 폴더 안 git은 래퍼가 실행한다.

초기 작업 구역에 파일이 없으면 bare 저장소에서 `.gitkeep` 생성 커밋을 만들고 시스템 배포 키로 보낸다. `pipeline.yaml`의 내용을 추측해 만들지는 않는다. 계약 반영은 요청 때 확인한 코드 명세와 현재 main이 같은 경우에만 수행하며, 지정 계약 파일 외 변경이나 검증 실패는 push하지 않는다. push 응답을 잃으면 저장한 결과와 원격 main을 먼저 대조한다. 코드 추출기가 없는 병합 후 snapshot은 「대조 안 함」으로 보고한다.

`pnpm -C agent-runner test -- queued-app`은 가짜 HTTP·CLI로 앱 시작부터 새 10종의 수신·보고를 검사한다. `TEST_DATABASE_URL=<전용 시험 DB> pnpm -C agent-wbs test:db -- runner-app`은 실제 API·PostgreSQL·Runner 앱·브라우저와 가짜 CLI로 저장소 확인 → 연결 확인 → 등록 → 기술 확정 → WBS 초안까지 검증한다. 산출물 위치는 `AWBS_RUNNER_JOBS_EVIDENCE`(기본 `/tmp/awbs-runner-jobs-evidence`)다. 실제 유료 CLI·GitHub·운영 DB는 부르지 않는다.

```sh
pnpm -C agent-runner install --frozen-lockfile
pnpm -C agent-runner check     # typecheck + lint + test. 실제 Claude/Codex/GitHub를 호출하지 않는다
pnpm -C agent-runner start     # .env의 AWBS_RUNNER_TOKEN 필요(.env.example 참고)
```

실제 npm 설치는 `pnpm -C agent-runner test:cli-update:real`로 따로 검사한다. 네트워크 연결과 PATH에 있는 npm·Codex·Claude, 두 CLI의 기존 로그인이 필요하다. 공식 최신 버전을 전용 임시 prefix(패키지 설치 위치)에 설치하고, 버전·로그인 상태·도움말을 확인한 뒤 링크를 교체한다. 예를 들어 Claude의 설치 후 처리 스크립트가 막혀 실행 파일이 만들어지지 않으면 이 검사가 실패한다. 모델을 호출하지 않으며, 사용 중인 전역 실행 파일의 내용·수정 시각이 같은지도 검사한다. 임시 설치는 `~/.orca/bots/agentwbs/archive/2026-11-26/M4-05/` 아래에 만들고 끝나면 지운다.

보고는 `Outbox.enqueue()`로 먼저 `AWBS_HOME/state/runner.json`에 저장한 뒤 전송한다. Outbox(보고 대기함)는 같은 요청을 여러 번 보내도 한 번만 처리하도록 멱등 키를 유지한다. 예를 들어 서버가 보고를 처리한 직후 Runner가 강제 종료돼도, 재시작하면 같은 키로 다시 보내 서버의 중복 처리를 막는다. 네트워크·408·429·5xx 오류는 간격을 늘려 재시도한다. 서버의 대기 지시까지 포함해 최대 60초이며, 실행 중에는 뒤로 가지 않는 단조 시계로 기다린다.

전송 거부는 `state/rejected/<보고 ID>.json`에 요청·오류 코드·원인·조치 방법을 별도 보관한다. 같은 프로젝트 번호·보고 종류·오류 코드·대상이면 파일 하나에 횟수, 첫/마지막 시각, 마지막 요청의 해시를 기록한다. 이전 버전의 중복 파일도 묶음별 한 번만 원문을 써서 합친 뒤 사본을 지운다. 메모리에는 작은 색인만 두며 `outbox.rejected`는 이 목록을 돌려준다. 보관 중인 원문이 필요하면 `state.readRejection(id)`를 비동기로 호출한다. 거부된 세션·수신 확인 보고는 이후 보고를 막지 않는다. 같은 시도의 앞 보고가 거부되면 그 시도의 뒤 보고만 막는다. 실행 계층은 `onRejected(entry)`로 즉시 통지받고, 재시작 때 `rejectedFor(attemptId)`를 조회해 `LEASE_LOST`(다른 실행자가 작업을 가져간 상태)인 작업을 멈춰야 한다.

정리 결과가 거부되면 다음 명령 조회를 바탕으로 다시 정리하되, 명령마다 1분·2분·4분 순으로 최대 30분까지 기다린다. 대기는 재시작 뒤에도 유지하고, 연속 5회 거부되면 내부 위험 알림을 남긴다. 다른 명령은 자기 대기 시간에 따라 독립적으로 처리한다.

원문은 **500건·합계 20 MiB·30일**을 넘기지 않는다. 1건은 64 KiB까지이며, 큰 필드는 앞 4 KiB와 해시·원래 길이로 남긴다. 한도를 넘으면 오래된 기록부터 `summary.json`에 건수·원인·프로젝트 번호·바이트·마지막 10건의 대조 키를 합친다. 요약을 디스크에 먼저 동기화한 뒤 원문을 지운다. 현재 시도를 막는 기록과 최근 24시간 기록을 우선 남기지만, 원문 한도를 넘으면 이들도 요약하고 시도 차단 근거는 작은 메타데이터로 유지한다. 고정 보관 시도가 200건을 넘으면 위험으로 알리며 차단 근거를 임의로 버리지 않는다. 지난 프로젝트 번호의 원문은 새 번호 확정 7일 뒤 요약한다. 종류별 요약 키는 최대 1,000개이고 넘으면 「기타」로 합친다.

깨진 거부 기록은 `state/rejected/corrupt/`로 격리하고 시작을 계속한다. 격리 원문도 같은 개수·크기·기간 한도에 포함하며, 넘으면 읽지 못한 건수와 바이트만 남긴다. 핵심 상태인 `runner.json` 손상은 계속 시작을 거부한다. `state.rejectionStatus`와 `state.rejectionAlerts`에서 원문·요약·고정 보관·격리·위험 상태를 조회한다. `readinessWarnings`와 Runner 로그에도 설명을 제공하지만 서버로 보내는 새 readiness 키는 추가하지 않는다. 보관 한도는 `State.open(home, {rejectionLimits: {...}})`에서 지정할 수 있다.

시도 이벤트 키는 `att:<attemptId>:<event>:<at>`, 일반 보고는 `<kind>:<runnerId>:<uuid>` 형식이다. 시각과 이벤트가 같은 요청을 중복해서 쌓으면 기존 항목을 돌려주고, 같은 키의 본문이 다르면 거부한다. 호출자는 요청의 선택 항목 `idempotencyKey`로 야간 점검의 `night:2026-11-26` 같은 계약 키를 지정할 수 있다. 증거 파일은 종류·내용 해시를 이벤트 이름에 포함해 같은 시각의 서로 다른 파일을 구분한다.

증거 바이트는 `state/evidence/`의 별도 파일에 저장한다. 파일 하나는 50 MiB(약 52 MB)까지 허용하고, 실제 크기와 보고 크기를 비교한다. 전송 성공·거부·초기화로 더 이상 필요 없는 바이트는 지우고, 거부된 파일의 해시·크기·원인은 남긴다. 이전 버전의 인라인 증거와 거부 기록도 시작할 때 옮긴다.

epoch(프로젝트 초기화 번호)가 바뀌면 이전 보고와 수신함을 비우고 새 일을 멈춘다. `Runner`의 `cleanup` 함수에 실제 정리 구현을 연결해야 하며, 연결되지 않았으면 정리 대기 상태를 유지한다. 정리 결과를 서버가 확인한 뒤에만 새 번호를 저장한다. 메시지는 디스크 수신함에 보관하며, 실행 계층이 지시를 실제로 전달한 다음 `ackMessage()`를 호출한다. 예를 들어 다음 실행에 넣어야 하는 지시는 조회만 했다는 이유로 수신 확인을 보내지 않는다.

`AWBS_HOME` 폴더 하나는 Runner 프로세스 하나만 사용한다. Linux·WSL의 `flock`(운영체제 파일 잠금 도구)이 두 번째 실행을 거부하고, 강제 종료 시 잠금을 자동으로 해제한다. 별도로 `State.open()`을 쓰는 호출자는 `finally`에서 `await state.close()`로 잠금을 해제해야 한다. 잠금을 얻은 뒤 남은 임시 파일을 정리하고, 기존 상태 폴더도 권한 0700으로 제한한다. 상태가 변하지 않았으면 파일을 다시 쓰지 않는다. 파일 저장은 임시 파일 기록·디스크 동기화·이름 교체·디렉토리 동기화 순서이고, 동기화가 끝난 뒤에만 메모리를 갱신한다. 토큰은 상태 파일에 저장하지 않는다.

테스트 임시 경로는 `AWBS_TEST_TMP`로 정할 수 있으며, 지정하지 않으면 운영체제의 임시 폴더를 쓴다. 특정 사용자 계정의 폴더가 없어도 테스트를 실행할 수 있다.
