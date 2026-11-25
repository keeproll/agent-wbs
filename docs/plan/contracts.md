# Agent WBS 구현 기준선 — 계약

G§8이 정한 경로·의미는 그대로 두고 빈 곳을 **보강**(★)한다. ★는 가이드에 없는 설계 결정이며 [architecture.md D-03](architecture.md#7-해석-결정-기록)이 근거다. 기계 판독 정본은 M1에서 만드는 `agent-wbs/contracts/openapi.json`이고, 그때부터 이 문서와 다르면 drift로 보고 함께 고친다.

## 1. 공통 규칙

| 항목 | 규칙 |
|---|---|
| 형식 | JSON UTF-8, 시각은 UTC ISO 8601(µs 허용), 날짜 `YYYY-MM-DD`(Asia/Seoul) |
| 팀장 인증 | 세션 쿠키. 변경 요청은 `X-CSRF-Token`. 없으면 401 `LEAD_UNAUTHORIZED` |
| Runner 인증 | `Authorization: Bearer`. 없음·폐기 401 `RUNNER_UNAUTHORIZED`. 팀장 API를 Runner로 부르면 403 `FORBIDDEN_PRINCIPAL` |
| epoch | 모든 `/api/runner/*`, `/api/planning/*`에 `X-Project-Epoch`. 불일치 409 `EPOCH_MISMATCH` `{currentEpoch}`. **예외(D-04)**: heartbeat, `GET /runner/commands`, 명령 결과 — 이전 epoch 허용, heartbeat는 204 + `X-Current-Epoch` 헤더, commands는 본문 `currentEpoch`. 명령 결과는 명령 ID·명령 epoch 일치 필수. 그 외 요청은 트랜잭션 안에서 재확인(data-model §5.1) |
| epoch 전환 | Runner는 409를 받으면 새 일을 멈추고 이전 epoch outbox를 **버린 뒤** commands를 조회, 정리 완료 후에만 새 epoch 저장 |
| 멱등 | Runner·Planning POST/PATCH는 `Idempotency-Key` 필수(없으면 400 `IDEMPOTENCY_KEY_REQUIRED`). 같은 키·같은 본문 → 저장된 응답 재생(`Idempotency-Replayed: true`), 다른 본문 → 409 `IDEMPOTENCY_CONFLICT`. 예외: heartbeat(자연 멱등) |
| 키 구성 | 시도 이벤트 `att:<attemptId>:<event>:<at>`(§9.1-6), 그 외 `<kind>:<runnerId>:<uuid>`. outbox에 쓸 때 생성해 재전송 때 유지 |
| 팀장 멱등 | 생성·승인·초기화·발송 POST는 선택적 `Idempotency-Key`. 화면은 항상 보낸다(버튼 이중 클릭·재시도) |
| 동시 수정 | **모든 팀장 수정**에 §1.3의 expected version 필수. 불일치 409 `VERSION_CONFLICT` `{current, changes[{at,actor,field,before,after}]}` (§0.3 충돌 창에 필요) |
| 페이지 | `?limit=&cursor=`, `{items,nextCursor}`. WBS 트리는 전체 요약 1회 |
| 속도 | Runner 429 + `Retry-After` 허용 |

### 1.1 오류 본문

```json
{"error":{"code":"DEPENDENCY_CYCLE","message":"…","action":"의존성 추가","fix":"…",
  "errors":[{"path":"title","rule":"maxLength","message":"…"}],"details":{"path":["TASK-0005","TASK-0006"]},"requestId":"…"}}
```

`message`는 무엇을 하려다·왜, `fix`는 조치(§0.3 L72). 비밀값·스택·로그 원문 금지.

| HTTP | 코드 | 화면/Runner 처리 |
|---|---|---|
| 400 | `VALIDATION_FAILED` `DEPENDENCY_SELF` `LIMIT_EXCEEDS_CAP` | 수정 안내, 재시도 없음 |
| 401/403 | 위 표 | Runner는 중지·경보 |
| 404 | `TASK_NOT_FOUND` `PROJECT_NOT_FOUND` `WBS_NODE_NOT_FOUND` `DEPENDENCY_NOT_FOUND` `ATTEMPT_NOT_FOUND` `MESSAGE_NOT_FOUND` | 안내 |
| 409 | `VERSION_CONFLICT` `EPOCH_MISMATCH` `DEPENDENCY_DUPLICATE` `DEPENDENCY_CYCLE` `TASK_HAS_SUCCESSORS` `EXTERNAL_WRITE_BLOCKED`★ `PROJECT_EXISTS` `INPUT_UNCHANGED` `ATTEMPT_CLOSED` `SCHEDULE_CYCLE` `INVALID_TRANSITION`★ `GATE_NOT_PASSED`★ `CLAIM_REJECTED`★ `LEASE_LOST`★ `CLEANUP_PENDING`★ `IDEMPOTENCY_CONFLICT`★ `DECISIONS_PENDING`★ | 재시도하지 않고 최신 조회 |
| 412 | — 사용 안 함(409로 통일) | |
| 422 | `SUBAGENT_INSTALL_FAILED`(job 결과 코드) | 시도 시작 안 함 |
| 429 | `RATE_LIMITED`★ | `Retry-After` |
| 500/503 | `INTERNAL` `UNAVAILABLE`★ | 다시 시도 / Runner 재시도 |

### 1.2 Runner 재시도

네트워크·408·429·5xx만 지수 백오프(1s→60s, jitter) 무기한 + outbox 영속. **시도별 순서 보존**: 앞 보고가 막히면 뒤 보고를 보내지 않는다. 다른 4xx는 `rejected`로 보존하고 readiness 경고로 올린다. 조회 timeout 10초, 업로드 120초 [결정]. 자동 처리 실패는 팀장 오류 막대가 아니라 반복 시 알림으로 올린다(§0.3 L71).

### 1.3 변경 명령별 비교 대상

G§0.3 L73 「모든 수정 API」를 따른다. 본문이 있으면 `updatedAt`, DELETE는 `?updatedAt=`로 보낸다. 누락 400, 불일치 409 `VERSION_CONFLICT`.

| 명령 | 비교 대상(aggregate) |
|---|---|
| Task PATCH·DELETE·승인·반려·완료·등급·분할·예외 | `tasks.updatedAt` (명세·설계·체크리스트·산출물 변경도 증가시킴) |
| 실행 요청·중단·재개 | Task + 중단은 시도 `updatedAt` |
| 의존성 추가·삭제 | **후속 Task** `updatedAt`. 변경 시 후속 Task도 증가, 순환은 잠금 안에서 별도 판정 |
| CP 제출·승인·반려·반영 | `change_proposals.updatedAt` + 미리보기는 `previewHash` |
| 기술 결정·불일치 처리 | 해당 행. 일괄 확정은 각 결정의 `updatedAt` 목록 |
| 초기 WBS 승인·재분석 | 초안 revision |
| 입력 분석·분석 안 함 | 확인한 커밋 목록 + `projects.updatedAt` |
| 초기화 | `confirmName` + 화면이 본 epoch |
| 설정 PUT·수신자·규칙·불가일·불안정 테스트 | 해당 설정/행 |
| 메시지 초안·전송·취소·재전송 | `messages.updatedAt` |
| 새 Task·메시지·보고서 생성, 연결 확인·미리보기·테스트 발송 | 기존 행을 수정하지 않음 — 멱등 키만. Task 생성은 잠금 안에서 부모 존재 판정 |
| 수동 발송·재발송 | 멱등 키 + 현재 `mail_log` 상태 |

예외: 자동 전이(Runner 보고·worker·자동 CP)는 사용자 편집이 아니므로 행 잠금 뒤 **현재 상태**와 fence를 판정한다. fence는 Task 편집 버전을 대신하지 않는다.

## 2. 팀장 API

### 2.1 WBS (§8.1)

| API | 요청 → 응답 | 오류 |
|---|---|---|
| GET `/api/projects/:projectId/tasks?status&q&includeDeleted` | → `{nodes[],tasks[TaskSummary]}` (`wbsPath`·차단·Gate 수·일정 요약 계산) | PROJECT_NOT_FOUND |
| GET `/api/tasks/:taskKey` | → `TaskDetail` | TASK_NOT_FOUND |
| POST `/api/projects/:projectId/tasks` | P TASK-0005 + 명세·AC·체크리스트(Wizard 3단계) → 201 `{id,taskKey,wbsPath,lifecycleStatus}` | VALIDATION_FAILED, WBS_NODE_NOT_FOUND |
| PATCH `/api/tasks/:taskKey` | `{updatedAt, …}` → `{task,changes[]}`. **status 필드 없음**(§5.5) | VERSION_CONFLICT |
| DELETE `/api/tasks/:taskKey` | 204 | TASK_HAS_SUCCESSORS |
| POST `/api/tasks/:taskKey/dependencies` | `{predTaskKey,depType}` → 201 `{dependency,blocked}` | DEPENDENCY_* |
| DELETE `/api/dependencies/:id` | 204 | DEPENDENCY_NOT_FOUND |

★ 화면 동작용 보강:

| API | 용도 |
|---|---|
| PATCH `/api/tasks/:taskKey/{spec,design/:kind,checklist/:itemKey,outputs}` · POST/DELETE checklist | 섹션별 편집(§4.4). §1.3 |
| POST `/api/tasks/:taskKey/approve` · `/reject` | 계획 승인 |
| GET `/api/tasks/:taskKey/gate` · POST `/complete` | Gate 조회, 완료 **판정 요청**(미충족 409 GATE_NOT_PASSED + 조건별 사유) |
| GET `/api/tasks/:taskKey/{history,attempts,verifications,messages}` | 탭 |
| PUT `/api/tasks/:taskKey/grade` · DELETE | 등급 고정·해제 → 재추정·재조정 |
| POST `/api/tasks/:taskKey/split` · `/split-exceptions` | 분할 제안 / 예외 사유 |
| POST `/api/tasks/:taskKey/runs` `{kind}` · POST `/api/attempts/:id/stop` · `/resume` | 실행 요청 job 생성 / 중단 / 재개. 불가 시 409 CLAIM_REJECTED `{reasons[]}` |
| GET/POST `/api/messages`, PATCH 초안, POST `/:id/{send,cancel,resend,read}` | §4.10. 초안 서버 보존 |
| GET/POST `/api/plannings`, POST `/api/plannings/:id/reviews/:rid/choice` · `/proposals` | §4.5 |
| GET/POST `/api/proposals`, GET `/:id/preview`, POST `/:id/{submit,approve,reject,request-changes,apply}` | 미리보기와 반영은 같은 함수. apply는 재시뮬레이션. 응답 `impact`에 `removedDependencies[{pred,succ,type,reason}]`·**`unblockedSuccessors[{taskKey,remainingBlockers[]}]`** — 취소로 관계가 제거된 후속과, 남은 선행이 없어 실제로 풀리는지를 구분(D-27) |
| GET `/api/dashboard`, `/api/schedule`, `/api/replans`, POST `/api/replans/run` | §4.1, §6 |
| GET `/api/verifications`, `/api/evidence`, `/api/evidence/:id/content`, `/api/gates`, `/api/history` | §4.7, §4.9. 콘텐츠는 attachment + nosniff |
| GET/PUT `/api/settings/{workflow,exec-policy,models,split,schedule,blackouts,concurrency,obs-budget,subagents,ci}` | §4.9 탭 |
| GET `/api/runner-state` | 연결·준비·PC·동시 실행·관측·제한 요인 묶음 |
| GET `/api/alerts`, GET `/api/system/integrity` | 현재 알림 / 정합성 점검 |
| POST `/api/auth/session` · DELETE, GET `/api/session` | §2.4 |

### 2.2 프로젝트 (§8.4)

| API | 핵심 |
|---|---|
| POST `/api/project/repo-checks` `{url}` | 형식 400 우선(저장소까지만) → 202 `{id}`, GET `/:id`★ 결과 |
| POST `/api/project` | 이름·url·목표일·제약·지시·`repoCheckId`★. 성공한 확인이 없거나 정리 대기면 409. → 201 `{project,jobId}` |
| GET `/api/project`★ | 등록·입력·bootstrap·변경 감지 |
| POST `/api/project/bootstrap/approve` · `/rerun` · `/retry`★ | 초안 revision 지정. approve → WBS+기준 v1을 한 트랜잭션 |
| POST `/api/projects/:projectId/boot/tech/confirm` `{decisions[{id,choice}]}` | 미결정이 있으면 409 DECISIONS_PENDING |
| POST `/api/project/inputs` `{commit,instr?}` · `/inputs/skip` · `/inputs/retry`★ | 409 INPUT_UNCHANGED |
| POST `/api/project/reset` `{confirmName,keepSettings}` · GET `/reset-preview`★ · GET `/export`★ | 건수·정리 내용 / 내보내기(비밀값·수신자 제외) |
| GET `/api/system/resets` | 초기화 기록 |
| GET·PUT `/api/settings/github`, POST `/check`★ | `tokenSet`만 |

### 2.3 보고서·메일(§8.5) · CI(§8.5-1) · 설계(§8.6) · Telegram(§8.7)

G§8.5, §8.5-1, §8.6, §8.7의 표 전체를 그대로 구현한다(재기술하지 않음 — 단일 출처). 보강만 적는다.

- 보고서: 기간 `from ≤ to ≤ 오늘`, 최대 93일 → 400. 수정·삭제 API 없음. PDF 실패 503 `PDF_FAILED`★.
- 메일 큐 키 `reportId+recipientId+tryNo`, 실패 15분 후 1회 자동 재시도.
- CI retry/deploy-check → 202 + job. `GET /ci/pipeline`★(정의 표시), GET·PATCH `/ci/settings`★.
- 불일치 `resolve{how:"contract"}`는 Runner job을 만들고 **결과 커밋이 보고된 뒤** resolved. 호환 깨짐은 기술 결정 승인 필요(§4.12).
- Telegram 오류: `token_invalid`(401) `chat_not_found`(400) `forbidden`(403) `rate_limited`(429) `network` `webhook_in_use` `chat_migrated`★(자동 교체 금지). 마스킹 문자열 토큰 400.

### 2.4 로그인 ★ (owner Q-01)

- POST `/api/auth/session` `{method:"link",token}`: loopback 연결만, 토큰 1회 소비 → 204 + 세션 쿠키. 프록시 헤더를 믿지 않고 socket 주소로 판정한다. 실패는 구분 없이 401 `LOGIN_FAILED`.
- `{method:"password",password}`: LAN 모드만. 횟수 제한 429, 성공 시 세션 교체. 비밀번호 분실은 이 PC CLI로 재설정.
- 로그인 화면 1개에 LAN 비밀번호 입력과 「이 PC에서는 새 링크 발급」 안내를 둔다. Origin 검사는 로그인에도 적용한다.

## 3. Runner API

### 3.1 가이드 정의 (§8.2, 요청 상세는 P TASK-0012)

| API | 보강·수정 |
|---|---|
| POST `/runner/heartbeat` `{runnerId,version,epoch}` | 204 + `X-Current-Epoch`. 60초 |
| POST `/runner/sessions` | stop은 열린 세션만. `reason=unknown`은 서버만 |
| POST `/runner/host` `/readiness` `/models` `/usage` `/concurrency` | readiness key에 `obs`★ `gh`★ `lfs`★ 추가. concurrency는 세션별 `{attemptId,observed,reserved,state}`★ 포함 |
| GET `/runner/tasks/:taskKey/run-grade?role=` | 등급 정책 단일 출처. 재작업 상향·재개·하향을 서버가 계산해 `{model,effort,adjust}`★로도 준다 |
| GET `/runner/tasks/:taskKey/subagents?role=` | 모델·effort 없음. hash 검증 후 설치 |
| GET `/runner/messages?cursor=` · POST `/:id/ack` | G의 `since` 대신 **cursor**를 우선 사용(같은 시각 유실 방지). `since`도 호환 |
| POST `/runner/messages/:id/response`★ | Agent 응답 `{text,workState}`. 전달 상태와 분리(§9.4-1) |
| POST `/runner/attempts/:id/status` | `subagents.used` 제거(D-12) |
| POST `/runner/attempts/:id/interrupt` | 200 `{taskStatus:"paused"}`, 종료된 시도 409 |
| POST `/runner/attempts/:id/result` | dev·rework: summary·changedFiles·evidence·failure·tokens. qa·reverify: **`verification{headSha,specRevision,result,cmd,expected,actual,defects[],checklist[]}`**★ 필수 |
| POST `/runner/attempts/:id/evidence`★ | multipart 1파일, sha256·크기 검증. 결과 보고 전 업로드하고 id로 참조 |
| POST `/runner/attempts/:id/subagent-usage`★ | 세션 종료 후 사후 확정(`confirmed/partial`) |
| POST `/runner/input-changes`, `/runner/repo-checks/:id/result`, `/runner/bootstrap/:jobId/progress` | §8.4 |
| POST `/runner/ci/runs`, PATCH `/:id` | §8.5-1 |
| POST `/runner/ci/queue`★ | 병합 상태(PR·병합 커밋) 보고 → 서버가 완료 판정 |
| POST `/runner/design/snapshot` | §8.6 |
| POST `/runner/github/status`★ | 인증 방식·계정·권한·만료(비밀값 없음) |
| GET `/runner/github/credential`★ | 토큰 방식일 때만. Runner 공개키로 봉인한 값(평문 없음) |
| GET `/runner/policy`★ | 상한·예산·주기·ci 설정·입력 확인 주기 묶음(`ETag`) |

### 3.2 명령과 작업 ★

```
GET  /api/runner/commands                → {currentEpoch, commands:[{id,kind:"reset-cleanup",epoch,payload}]}
POST /api/runner/commands/:id/result     → {status, items:[{name,ok,detail}]}
POST /api/runner/jobs/claim {kinds[],capacity} → 200 {job:{id,kind,payload,leaseUntil,fence}} | 204
POST /api/runner/jobs/:id/renew {fence}  → {leaseUntil}         409 LEASE_LOST
POST /api/runner/jobs/:id/start {fence,hostId,bootId,processGroup?,headSha,installedSubagents[]} → {attemptId?}
POST /api/runner/jobs/:id/process {fence,processGroup,cgroup}      → 프로세스 생성 직후 보유에 기록
POST /api/runner/jobs/:id/slots/release {fence,hostId,proof,at}      → 물리 슬롯만 반환, 논리 잠금 유지
POST /api/runner/jobs/:id/slots/acquire {fence,hostId,processGroup}  → 같은 시도의 CLI 재기동 전 용량 재획득·그룹 등록
POST /api/runner/jobs/:id/release {fence,hostId,proof,at}            → 잔여 보유 해제(낡은 fence도 허용, 아래)
POST /api/runner/jobs/:id/reconcile {fence,evidence}                  → 외부 상태 대조 결과
POST /api/runner/jobs/:id/finish {fence,status,result?,error?}
```

| kind | payload | 종료 보고 |
|---|---|---|
| `repo_check` | url | repo-checks result |
| `bootstrap` / `input_diff` | 커밋, 지시, 이전 커밋, 재개 단계 | progress → draft / proposal |
| `planning` / `estimate` / `split` | 대상 Task, 정책 | planning API |
| `attempt` | taskKey, kind, agent, 브랜치, 기준 커밋, 입력 버전, 작업 지시 묶음 | status → result/interrupt |
| `stop_attempt` | attemptId, 사유 | interrupt |
| `integrate` / `deploy_check` / `ci_retry` | PR·커밋 | ci runs, queue |
| `design_apply` / `merge_followup` | 항목·PR | design snapshot |

규칙:

1. 정리 명령이 남아 있으면 claim은 409 CLEANUP_PENDING.
2. `attempt` claim 시 서버가 한 트랜잭션에서 선행·Task 상태·상한·Agent 상한·충돌 묶음·readiness·사용량·관측 미확인·등급과 **다른 job의 미해제 보유**를 확인하고 슬롯 `reserved`·잠금 `held`로 예약한다(인계받은 job은 자기 잠금을 그대로 사용). 시도는 아직 만들지 않는다. 설치 성공 뒤 `start`는 [data-model §2.5-1](data-model.md#25-1-실행-보유의-단일-정의)의 **자기 보유**만 예외로 인정하고 다른 job의 보유와 전체 용량을 다시 검사한 뒤 `slot_state reserved→active`·시도 생성·Task 전이를 한 트랜잭션으로 처리한다. 중복 start는 같은 attemptId를 재생하고 전환은 1회다. claim 실패 시 job은 대기하고 `reasons[]`를 화면에 보인다(§4.6).
3. lease 60초, 20초마다 renew [결정]. lease 만료는 **자원 해제가 아니다**. 조회 전용 job(`repo_check`)만 바로 재할당한다. attempt와 외부 효과 job은 §3.4.
4. 모든 보고는 `fence`를 포함하고 낡은 fence는 409 LEASE_LOST. 예외: `release`는 **원래 job·host·boot·process group이 일치**할 때 낡은 fence도 받되 보유 해제 외 상태는 바꾸지 않는다.
5. 야간 점검과 입력 변경 확인은 Runner가 `policy` 시각으로 시작한다. 중복은 멱등 키 `night:<date>`로 막는다.
6. 자동 실행과 한도는 §3.5.

### 3.3 Planning API (§8.3, §8.4)

| API | 규칙 |
|---|---|
| POST `/planning/estimates` | P TASK-0012. 완료 Task 거부 |
| POST `/planning/replans` | 서버가 일정을 **다시 계산**. 제출 용량은 참고값. 정책 off → 202(D-10) |
| POST `/planning/bootstrap/:jobId/draft` | phases·wps·tasks(분류·담당·추정·명세·AC·체크리스트·등급·하위 Agent·분할 근거·충돌 묶음·설계 항목)·deps. 순환·참조·필수 검증, 실패 400 |
| POST `/planning/bootstrap/:jobId/tech`★ | 기술 결정 제안(근거·대안) |
| POST `/planning/sessions`★ · `/:id/analyses` · `/:id/reviews` | §4.5 두 분석·교차 검토 |
| POST `/planning/proposals`★ | CP 제출. 서버 정책에 따라 자동 반영/보류/검토 |
| POST `/planning/tasks/:taskKey/plan`★ | 등급·하위 Agent·충돌 묶음 판단과 근거 |

### 3.4 실행 보유와 복구

1. **시도 종료 ≠ 자원 반환.** heartbeat 3회 누락이면 §6.5대로 시도 `interrupted`, Task `paused`로 기록하지만 보유는 `slot_state=unconfirmed`, `lock_state=held`로 남는다. 슬롯·충돌 묶음·Task 재개를 계속 막고 사유를 화면에 보인다(§6.7 L804-806).
2. 해제 증거: `no_process`(프로세스를 만든 적 없음), `group_empty`(Runner가 그룹·자손 empty 확인), `boot_changed`(같은 host의 boot ID 변경 — 이전 프로세스가 존재할 수 없음). 출력 단절·lease 만료·시간 경과는 증거가 아니다.
3. Runner는 프로세스 생성 **전에** 예정된 그룹/cgroup 이름을 로컬에 영속화한다. 재시작 시 로컬 기록과 서버 보유를 대조해 정리하고 release한다. 기록이 없거나 확인할 수 없으면 `unconfirmed`를 유지하고 알린다.
4. 같은 PC에서 증거 없이 보유를 푸는 강제 API는 두지 않는다.
5. **PC 변경**: §6.6 L749-751이 새 PC에서 새 시도 재개를 확정했으므로, 이전 host 보유는 슬롯 `unconfirmed`·잠금 `orphaned`로 남기되 새 host의 슬롯 계산과 재개 차단에서 제외한다. host 식별자 변경 없는 단순 재시작에는 적용하지 않는다. **로컬 재개와 공유 외부 쓰기는 분리한다.** `renew`·fence는 GitHub가 알지 못하므로 외부 쓰기 격리 근거로 쓰지 않는다.
   - host가 바뀌면 서버가 `external_write_authority`를 generation+1, `blocked`로 바꾼다. 새 host는 로컬 worktree의 dev·①·QA까지만 하고 push·PR·commit status·병합·design_apply·초기화 되돌림을 포함한 GitHub 쓰기는 409 `EXTERNAL_WRITE_BLOCKED`로 막는다. 사유는 기존 실행 불가 사유·관리자 개입 알림에 표시한다. 배포 확인은 host별 로컬 compose만 대상으로 하고, 공유 대상이면 같은 차단을 적용한다.
   - 해제 조건은 (a) 이전 host가 재연결해 프로세스·outbox 종료와 이전 호출 결과를 확인하거나 (b) 이전 쓰기 자격 증명을 **GitHub에서 폐기**하고 서버가 폐기를 확인(기존 토큰 호출 401)한 뒤 새 자격 증명을 등록하는 것이다. 이후 GitHub main·PR·브랜치·status를 조회해 이전 호출을 대조해야 `granted`가 된다. `gh` 로그인처럼 폐기를 확인할 수 없으면 (a)만 가능하다.
   - 새 host 브랜치는 `agent/<TASK>-h<generation>`, PR도 새로 만든다. 이전 generation 브랜치·PR은 대조 뒤 병합 대상에서 제외하고 정리한다.
   - 이전 host가 나중에 연결되면 정리·대조 명령만 받고 generation 없는 쓰기를 하지 않는다.
   - 권한은 job마다 generation을 저장하고 `integrate` 시작·병합 API 직전·완료 판정 때 대조한다. 이것은 협조적 검사이고, 늦은 옛 호출의 최종 차단은 자격 증명 폐기와 대조다.
6. 외부 효과 job(`integrate`,`deploy_check`,`design_apply`,`merge_followup`, 초기 분석의 커밋 단계): lease 상실 시 `reconcile`로 두고 재할당하지 않는다. 이전 그룹 종료를 확인하고 GitHub main/PR/status 또는 compose 상태를 실제 조회해 「효과 없음 / 완료됨 / 부분 적용」을 보고한 뒤에만 완료 확정 또는 새 실행을 허용한다. 부분 적용은 실패와 조치 안내로 남긴다.
7. 같은 host 안에서는 원격 호출 직전 lease를 renew한다. 호출 뒤 응답 유실은 조회로 대조한다. 다른 host 격리는 5번을 따른다.
8. 논리 잠금(Task·충돌 묶음)은 claim부터 dev→①→(같은 시도 수정)→result까지 유지하고 다음 QA job으로 **원자적으로 인계**한다. QA 종료가 확정되면 해제하며 rework job이 함께 생성되면 그 job으로 인계한다. 물리 슬롯은 CLI·① 각각 실행할 때만 잡는다. ① 명령도 그룹·cgroup을 등록하고 무거운 작업 슬롯을 쓴다. 슬롯을 다시 못 잡으면 잠금을 유지한 채 대기하고 사유를 표시한다.
9. QA가 사용량 등으로 오래 대기하면 같은 묶음도 대기한다(직렬화 우선, §6.6 L741). Task가 `paused`·`failed`·BLOCKED로 끝나면 그룹 empty 확인 후 논리 잠금을 해제하고 재개 때 다시 예약한다.

### 3.5 자동 진행 (owner Q-04)

- 최초 dev는 팀장 `POST /tasks/:key/runs`가 있어야 job을 만든다. 이후 ①→QA→(FAIL) rework→reverify는 서버가 job을 만든다.
- 실행 실패: **같은 종류(dev/qa/rework/reverify)의 연속 실패에 자동 재시도 2회, 최초 포함 총 3회**. 그 종류가 완료되면 연속 횟수를 0으로 되돌린다. 중단은 실패로 세지 않고 횟수를 바꾸지 않는다. 시작 전 실패는 항상 「다시 시도」 버튼(G L864, P).
- QA FAIL과 통합 실패를 합쳐 Task당 **자동 재작업 최대 3회**. 재작업 안의 실행 실패는 재작업 횟수로 세지 않는다. BLOCKED·중단은 세지 않고 자동 반복하지 않는다.
- 초과하면 추가 job을 만들지 않고 팀장 알림. 팀장 버튼은 한도 카운터를 되돌리지 않고 1회만 허용한다.
- Telegram 「Task 실패」: QA FAIL 확정, 실행 실패의 자동 한도 초과(§4.14). 자동 재시도 중 실패는 보내지 않는다.
- 서버 재시작·중복 보고에도 원인 시도와 회차로 job 고유키를 둔다.

## 4. 대표 흐름

### 4.1 시도 1회

```mermaid
sequenceDiagram
  participant R as Runner
  participant W as WBS
  R->>W: jobs/claim
  W-->>R: attempt job (예약만, 시도 없음)
  R->>W: run-grade, subagents, messages
  R->>R: worktree · 하위 Agent 설치(hash)
  alt 설치 실패
    R->>W: jobs/finish SUBAGENT_INSTALL_FAILED + release (시도 없음, Task 불변)
  else
    R->>W: jobs/start → attemptId (시도 생성·Task 전이)
    R->>W: status running(model, effort, adjust) + messages ack
    R->>R: CLI 실행 → 종료 → 프로세스 그룹 비움
    R->>W: slots/release (group_empty) — Task·충돌 묶음 잠금은 유지
    R->>W: ci/runs(task) ① (무거운 작업 슬롯)
    opt ① 실패
      R->>W: slots/acquire (그룹 등록·용량 재검사)
      R->>R: 같은 시도에서 CLI 수정 → slots/release → ① 반복
    end
    R->>W: evidence → result
    W->>W: Task qa + QA job + 논리 잠금 인계 (같은 트랜잭션)
  end
```

QA PASS → `gate` → `integrate` → ② 통과 → PR 병합 → `ci/queue merged` → 서버 Gate 재판정 → `done`. 별도 완료 승인 없이 서버가 `integrate` job을 만들고 병합 확인 뒤 자동 완료한다(owner Q-02). 사전 조건은 ②를 제외한 Gate 5조건(승인=착수 승인)이다. 「완료 처리」 버튼(P L5389)은 같은 판정을 다시 요청할 뿐 우회하지 않는다.

#### 코드 근거 고정

1. 개발 종료 시 변경을 commit하고 ①·QA는 같은 `headSha`와 `specRevision`을 검사한다. QA는 읽기 전용 상태에서 시작하고 종료 시 SHA·worktree 청결을 다시 확인해 보고한다.
2. 사람이 만든 변경·Agent 변경으로 head가 바뀌거나 명세·AC·명세가 참조하는 입력 버전이 바뀌면 이전 QA를 무효화하고 재검증한다. 낡은 SHA의 PASS는 거부한다.
3. **병합 경로는 하나다: strict up-to-date 보호 + 예상 head를 받는 PR 병합 API.** main 직접 fast-forward push로 일반 PR을 병합하지 않는다.
   1. 병합 대기열 차례에 main A, QA한 head H를 고정한다. H가 A를 포함하지 않으면 Runner가 A를 PR 브랜치에 충돌 없이 병합해 H'를 만든다(부모 정확히 H,A, 자동 병합 결과 tree와 일치, 추가 변경 없음). 포함하면 H'=H. 충돌하면 `rework`.
   2. H→H'는 위 조건을 기계로 확인한 경우에만 QA H의 근거를 잇고(§4.13의 「검증 PASS 후 main+PR 병합본 통합 확인」), ①과 ②를 **H'에서** 다시 실행한다. `pipelineSha`는 A의 정의다. 조건이 깨지면 QA 무효.
   3. H'는 A를 포함하므로 검사 tree가 병합 결과 tree다. 대기열이 H'를 갱신한 이후 다른 push를 막을 수 없으므로 head가 바뀌면 결과를 버린다.
   4. ② 통과 후 `agentwbs/int`를 **PR head H'**에 게시한다. 같은 context를 test merge commit에 게시하지 않는다(GitHub는 test merge commit에 status가 있으면 그것을, 없으면 head를 요구).
   5. `PUT /repos/{owner}/{repo}/pulls/{n}/merge`를 `sha=H'`, `merge_method=merge`로 호출한다. head 변경은 409, main 이동·검사 미충족은 strict 보호가 405로 거부한다. 거부되면 main/head를 다시 조회하고 1부터 재시작하며, 같은 실패 반복은 알린다.
   6. 응답 유실이면 PR 상태를 대조한다. 성공이면 병합 커밋의 부모가 A와 H', tree가 H'의 tree인지 확인하고 actual SHA를 기록한다. 다르면 `done`으로 만들지 않고 알린다. main을 자동으로 되돌리지 않는다(§9.6-2-3).
   7. main 보호: int 필수, strict up-to-date, 강제 push·삭제 금지, CODEOWNERS 검토(`prototype/`, `.agentwbs/`). **일반 병합용 Runner 자격 증명에는 우회 권한을 주지 않는다.** 관리자 우회 기본값에 기대지 않도록 관리자가 아닌 별도 계정/앱을 쓰고 준비 점검에서 실효 규칙을 조회한다.
   8. 실증은 M7-02 확정 전에 시험 저장소에서 한다(M4-06). 실패하면 M7-02를 닫지 않는다.
   근거: [병합 API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request)의 `sha` 불일치 409, [보호 브랜치](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)의 strict, [필수 검사 문제 해결](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)의 검사 대상 커밋(2026-11-25 확인). 문서는 비동기 병합도 권장하지만 `PUT /merge`에 폐기 표시가 없고 결과를 한 번에 확정하므로 동기 API를 쓴다. stacked PR·GitHub merge queue는 쓰지 않는다.
4. 묶음 확인(§4.13)은 **원인 탐색·예비 검사로만** 쓴다. 병합은 각 PR이 자기 H'에서 ②를 통과한 뒤 하나씩 위 경로로 한다.

### 4.2 전이 트랜잭션

상태 변경 = 행 잠금 → 전이 검사 → 변경 + 이력 + `alerts` + `notify_events/outbox` + `change_events` + 일정 재계산 표시. 커밋 후 worker가 발송한다(§9.6-3-5). 일정은 프로젝트당 합쳐 계산하고 결과에 `calcVersion`을 둔다.

### 4.3 Runner 끊김

3회 누락 → 서버 세션 종료(unknown), 열린 시도 `interrupted`, Task `paused`. 이후 도착한 이전 시도 결과는 409 ATTEMPT_CLOSED로 거부하되 **요약만** 진단용으로 이력에 남긴다 [결정]. 자원 해제와 재개 가능 여부는 §3.4.

### 4.4 외부 전송의 불확정 구간

- SMTP·Telegram에는 이 설계가 의존할 수 있는 멱등 키가 없으므로 **정확히 1회 도착을 보장하지 않는다.** 논리 발송 ID는 DB 중복만 막는다.
- `sending`은 호출 전에 커밋하고, 명시적 수락 응답만 `accepted`다. 연결 전 실패나 명시적 거부처럼 수락되지 않은 것이 확실하면 실패/재시도 규칙을 적용한다.
- **메일**(G§9.6-6 「두 번 나가지 않게」): 전송 본문을 보낸 뒤 응답 유실·timeout·프로세스 crash는 `unknown`. 15분 자동 재시도에서 제외하고 실패 알림에 포함, 팀장이 중복 가능 안내를 보고 다시 보낸다.
- **Telegram**: 같은 이벤트 키의 새 outbox는 해소 전 1개(§4.14). 통신 실패 재시도는 G§9.6-3-2가 확정했으므로 응답 유실·crash도 횟수 제한 안에서 재시도한다. 이때 중복 도착 가능성을 이력 오류 요약에 남긴다. 마지막까지 불명이면 `unknown`.
- 두 채널의 unknown은 Task·Agent 상태에 영향을 주지 않는다.

## 5. Agent 출력 계약 (Runner 내부) ★

- 모든 Agent 종료 메시지는 JSON Schema로 검증한다. 형식 불일치는 1회 수정 요청, 이후 실패.
- dev: `{summary, selfCheck[], followups[], designItems[]}` — 변경 파일은 자기보고가 아니라 **git diff**.
- qa: `{verdict, criteria[{acId,result,cmd,expected,actual,evidence}], defects[]}` — 종료 코드·로그는 Runner 관측을 우선(§4.13).
- 지시문 포함: Task 명세·제외 범위·AC·관련 설계 항목과 직접 연결 항목만(§4.12), 하위 Agent 예산(§6.7-5), 보호 경로, 입력 버전.
- 입력 문서는 데이터로 취급하고, 안의 지시가 정책을 바꾸지 못한다고 명시한다.

## 6. GitHub 계약 (Runner)

브랜치 `agent/<TASK>`(P 표기), PR 1개/Task(host generation별 새 PR), main 직접 push는 최초 생성·초기화 되돌림 두 종류만 허용(별도 시스템 커밋 자격 증명 — Q-09), status context `agentwbs/task|int|night|deploy`. 서버 보고와 GitHub 보고는 독립 outbox(§9.6-2-6). 초기화: PR 닫기 → `agent/*` 중 **이 시스템이 기록한 브랜치만** 삭제 → 기준 커밋 상태의 `src/ contracts/ .agentwbs/`로 되돌림 커밋(강제 push 없음). 등록 전 파일은 기준 커밋 내용으로 복원된다.

## 7. 변경 이벤트

`GET /api/changes?after=<seq>&limit=500` (팀장) → `{events:[{seq,topic,ref,at}],next,reset}`. 보존 범위를 벗어나거나 epoch가 바뀌면 `reset:true` → 전체 재조회.

topic: `task` `dependency` `attempt` `verification` `message` `proposal` `planning` `schedule` `runner` `ci` `design` `report` `mail` `notify` `alert` `project` `settings`. 본문을 싣지 않고 참조만 보낸다(권한·일관성은 조회 API가 담당). 순서는 커밋 순서를 보장하도록 프로젝트 잠금 안에서 seq를 발급한다.

## 8. 계약 검증

- `openapi.json` 재생성 diff 0, Runner client 재생성 diff 0.
- 같은 요청·응답 fixture를 WBS(inject)와 Runner(client)가 함께 통과.
- Runner API 전체에 대해 무토큰·팀장 세션·낡은 epoch·멱등 재전송·키 충돌 5종 표 기반 테스트.
- 초기화 경합: middleware 통과 뒤 정지한 host 보고, 생성 중 PDF, 발송 시작 직전/직후를 초기화와 교차.
- 보유: 네트워크 단절+자손 생존+재개 요청은 거부, 그룹 종료 확인 뒤 허용. ① 실패 직전 같은 묶음 Task claim 거부. 자기 예약 start 성공, 타 job 예약 침범 거부.
- host 전환: `renew 성공→정지→host 전환→옛 호출 재개`에서 새 쓰기는 대조 전 차단되고 옛 결과가 대조에 나타남.
- P에 있는 Endpoint와 G§8 표의 모든 경로가 라우트 목록에 있는지 자동 비교.
