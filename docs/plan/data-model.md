# Agent WBS 구현 기준선 — 데이터 모델

표기는 [architecture.md](architecture.md)와 같다. 논리 객체는 G§5.1, 물리 테이블 구분은 [결정]이다. 컬럼은 주요 항목만 적었고 최종 타입은 M1 마이그레이션에서 고정한다.

## 1. 공통 규칙

- PK `uuid`(DB 생성), 표시 ID(`TASK-0007`, `ATT-0007-2`, `CP-001`, `RP-004`, `CI-0118`, `TD-03`)는 별도 unique 컬럼. **참조는 Task ID**(§9.1-1), FK는 내부 uuid.
- 표시 ID 순번은 `counters(project_id, kind, value)`를 트랜잭션 안에서 증가. 재사용하지 않는다. 시도 번호는 Task별.
- 시각 `timestamptz`, 날짜만 의미 있는 값(목표일·작업 불가일)은 `date`.
- 변경 가능한 행: `created_at`, `updated_at`(단조 증가). 수정 API는 `updatedAt` 비교(§0.3 L73).
- 프로젝트 데이터는 모두 `project_id`(단일 프로젝트지만 초기화 삭제 기준). 설정·환경은 `project_id` 없음.
- FK 기본 `ON DELETE RESTRICT`. 물리 삭제는 초기화 함수에서만. Task는 `deleted_at` soft delete, CP 취소는 `cancelled`.
- 값이 고정된 종류는 PostgreSQL enum, 자주 늘어날 종류(알림 사유·이력 유형)는 text + CHECK.
- 구조가 자유로운 명세·스냅샷은 `jsonb` + 쓰기 시 TypeBox 검증 + `schema_version`.

## 2. 테이블

### 2.1 시스템 · 인증 (초기화와 무관)

| 테이블 | 주요 컬럼 · 제약 | 근거 |
|---|---|---|
| `system_state` | 단일 행(`id=1` CHECK), `epoch int`, `cleanup_status(none/pending/running/failed)` | §4.2 L261 |
| `reset_log` | epoch, at, actor, deleted_task_count, keep_settings, runner_cleanup_status, finished_at — 프로젝트와 별도 보존 | §4.2 L258 |
| `runner_commands` | kind(`reset-cleanup`), epoch, payload(저장소·기준 커밋·브랜치·경로), status, attempts, result | §8.4 |
| `file_delete_queue` | path, reason, attempts, last_error | §9.5-1 |
| `lead_sessions` | token_hash unique, expires_at, csrf_hash | §8 |
| `runner_tokens` | token_hash unique, runner_id, public_key, revoked_at | §8 |
| `secrets` | key PK, ciphertext, nonce, key_version, last4 | §8.7 |

### 2.2 프로젝트 · 입력

| 테이블 | 주요 컬럼 · 제약 | 근거 |
|---|---|---|
| `projects` | 단일 행 보장 unique(`singleton=true`), name, repo_url/owner/name, branch=`main`, base_commit, target_date?, lead_instruction, phase(`boot/active`) | §4.2 |
| `repo_checks` | url, status, result(jsonb: private·commit·구조), error — 등록 전 생성 가능(project_id null) | §8.4 |
| `input_versions` | unique(project, v), commit_sha unique(project), files, md_list, changes, instruction, result — 추가 전용 | §4.2 L246 |
| `input_change_commits` | unique(project, sha), files, state(`pending/skipped/analyzed`), analyzed_in_version | §4.2 ② |
| `planning_jobs` | kind(`bootstrap/input_diff/planning/estimate/split`), run_no, status, fail, instruction — 프로젝트당 열린 bootstrap 1개(부분 unique) | §4.2 §8.4 |
| `planning_job_steps` | job, step_key, status(`wait/run/done/fail`), note, started/finished_at | §0.3 |
| `planning_job_logs` | 추가 전용 | §0.3 |
| `wbs_drafts` | job, revision, content(jsonb), split_check, status — 승인 전 WBS 미반영 | §4.2 L237 |

### 2.3 WBS · Task

| 테이블 | 주요 컬럼 · 제약 | 근거 |
|---|---|---|
| `wbs_nodes` | kind(`phase/work_package`), parent_id, title, sort_order. CHECK: phase는 parent 없음 | P TASK-0004 |
| `tasks` | task_key unique, wbs_node_id, sort_order, title(1~200), work_type, primary_domain, related_domains[], priority(0~3), assignee/verifier_agent, **status**(§3.1), verif_state, planning_approved_at, fix_start, act_start/act_end, conflict_group, src_input_version, deleted_at. CHECK `primary_domain <> ALL(related_domains)`. `wbs_path`는 저장하지 않고 계산(§9.1-1) | §5.2 §5.3 |
| `task_specs` | task PK, overview(jsonb: 목적·배경·범위·제외·선행/완료 조건), spec(jsonb: req·work·steps·inputs·outputs·files·constraints·errors·docs·verify), ac(jsonb[] given/when/then/method) | §4.4, P `SPEC_GROUPS` |
| `task_outputs` | name, kind, required, verify, delivered, delivered_attempt | §5.5 |
| `task_designs` | task, kind(`DB/API/FE/DevOps`), content(jsonb, P `DESIGN` 스키마) | §4.4 |
| `task_design_items` | task, item_key(`METHOD path`, `store:name`, 토픽, 키 패턴), change — 충돌 묶음·불일치 공용 키 | §9.6-1-2 |
| `task_dependencies` | pred, succ, dep_type(`FS/SS`), unique(pred,succ), CHECK pred≠succ | §5.4 |
| `checklist_items` | item_key, content, required, done, verify_method, evidence, note, sort_order, unique(task,item_key) | §4.4 |
| `task_estimates` | 추가 전용: est/lo/hi hours(`lo<=est<=hi` CHECK), tokens_k, confidence, basis, agreed_by | §8.3 |
| `task_grades` | role(`dev/qa`), model_id, effort, reason, locked, locked_by, effective_from | §7.1 |
| `task_subagents` | role, subagent_id, basis | §7.4 |
| `task_splits` | basis, judged_rules(jsonb), exceptions(jsonb: rule·why·by·at) | §5.2-1 |
| `task_source_links` | fix_task → origin_task(버그 수정), split_from | §5.2-1 L622 |

### 2.4 Planning · 변경 제안

| 테이블 | 주요 컬럼 · 제약 | 근거 |
|---|---|---|
| `plannings` / `planning_analyses` / `planning_reviews` | 세션 / Agent별 독립 분석 unique(planning, agent) / 주제별 일치·이견·조정 | §4.5 |
| `change_proposals` | cp_key, source(planning/message/manual/split/input/decision), status(§3.6), ops(jsonb §5.6), id_map, preview_hash, hold_reasons | §4.8 §5.6 |
| `change_proposal_events` | 제출·승인·반려·반영·보류, actor, comment — 추가 전용 | §4.8 |

### 2.5 실행 · 검증

| 테이블 | 주요 컬럼 · 제약 | 근거 |
|---|---|---|
| `runner_jobs` | kind, payload, state(`queued/leased/done/failed/cancelled`), lease_owner, lease_until, fence int, epoch, attempts | D-03 |
| `task_attempts` | attempt_key unique, task, kind(`dev/qa/rework/reverify`), agent, status(§3.2), started/ended_at, model_id, effort, grade_adjust(kind·reason), summary, failure, tokens, resumed_from. **Task당 열린 시도 1개**(부분 unique), 충돌 묶음은 claim 시 advisory lock으로 검사 | §4.6 §6.6 |
| `attempt_files` | 저장소 상대 경로 | §8.2 |
| `attempt_subagents` | designated/installed/observed_used, version, def_hash, confirm(`confirmed/partial`) | §6.7-7 |
| `attempt_observations` | cli, version, grade, observed, reserved, state(`ok/unconfirmed`), pgid/cgroup 상태, at | §6.7 |
| `verifications` | attempt unique, result(`PASS/FAIL/BLOCKED`), cmd, expected, actual — 추가 전용 | §4.7 |
| `defects` | def_key, verification, blocking, resolved_by_verification — **원 행은 불변, 해소는 이벤트 행** | §5.5 |
| `evidence` | task, attempt?, verification?, checklist?, kind, storage_path, sha256, size | §4.7 |

### 2.6 Runner · 정책

| 테이블 | 주요 컬럼 | 근거 |
|---|---|---|
| `runner_sessions` | started_at, ended_at, end_reason, last_heartbeat_at — 종료 1회 외 불변 | §8.2 |
| `runner_hosts` | host_id, cpu, cores, mem/swap/disk, os, per_session_gb, samples, seen_at(이력) | §6.6 |
| `runner_concurrency_log` | limit, running, subagents(관측/보유), heavy, resources, adjust(from/to/reason) | §6.6 |
| `concurrency_settings` | mode(auto/manual), caps, mem_reserve_gb, subagent_budget(dev/qa) | §6.6 §6.7 |
| `runner_readiness` | key, status, detail, fix, at | §7.4 |
| `agent_usage` | agent, remain_pct(0~100), reset_at, tokens_used | §6.2 |
| `agent_models` / `agent_efforts` | 보고값, rank, allowed(신규=false), is_new / CLI 값→공통 1~5 매핑 | §7.2 |
| `exec_policy` | on_usage, low_pct, on_rework, esc_notify, floors, live_inject, retry_limit | §7.3, Q-04 |
| `subagent_defs` | id, version, agent, role, tools, sandbox, text, hash, allowed, ref — 버전 불변 | §7.4 |
| `cli_observation_grades` | cli+version+model+options unique, grade, verified_at, notes | §6.7 |

### 2.7 일정 · 보고서 · 알림 · 설정

| 테이블 | 주요 컬럼 · 제약 | 근거 |
|---|---|---|
| `schedule_policy` | auto_replan, cp_auto, threshold_days, assume_rate, window_days=7, min_hours=72 | §6.4 §10 |
| `blackout_days` | date unique, note | §6.2 |
| `schedule_baselines` / `baseline_items` | unique(project, v), 예상·범위·적용 가동률 / Task별 시작·종료·lo·hi — 추가 전용 | §6.4 |
| `replans` / `replan_moves` | rp_key, trigger, actor, baseline_v?, status(`applied/pending`), before/after / Task별 이동·신규·제외 | §6.4 |
| `reports` | kind, from, to, view 기본값, snapshot(jsonb), generated_at, due_at, reason. 정기: unique(project, kind, from, to) 부분 인덱스. **불변** | §4.11 §8.5 |
| `report_pdfs` | report, view, path, sha256 (캐시) | §8.5 |
| `mail_settings`/`mail_recipients` | SMTP(비밀값은 secrets) / email lower unique, daily/weekly 하나 이상 또는 inactive | §4.11 |
| `mail_outbox` / `mail_log` | unique(report, recipient, try_no) / 수신자 삭제 후에도 주소 보존 | §9.6-6 |
| `notify_settings`/`notify_rules` | enabled, chat_id, target_name, bot, 테스트 입력 지문 / 이벤트 6종 | §4.14 |
| `notify_events` | dedup_key, resolved_at, dup_count. **열린 키 1개**(부분 unique where resolved_at is null) | §8.7 |
| `notify_outbox` / `notify_log` | 대기·시도·next_at / 업무·테스트, 상태, 오류 요약 | §8.7 |
| `alerts` | 대시보드 현재 상태 알림: key unique(열림), severity, target | §4.1 §4.14 L522 |
| `app_settings` | app_url, heartbeat 주기·누락 횟수, 분할 기준, 작업 흐름 기본값, 시간대 | §4.9 |
| `github_settings` | mode, status, scopes, expires_at, account | §8.4 |

### 2.8 설계 · CI · 이력

| 테이블 | 주요 컬럼 · 제약 | 근거 |
|---|---|---|
| `tech_constraints` | 이름, level(must/cond/ban), condition — 등록 시 | §4.2 |
| `tech_decisions` / `tech_decision_events` | td_key, authority(lead/agent/free), status(fixed/approved/pending/rejected/noted/change) | §4.12 |
| `design_snapshots` | commit, ref(main/브랜치), parse 상태 — 커밋 기준 캐시 | §9.6-1-1 |
| `design_files` / `design_items` / `design_edges` / `design_ownership` | 파일 파싱 결과(마지막 성공 유지) / unique(snapshot, item_key) / API×테이블·구성도 | §4.12 |
| `design_drifts` / `design_versions` | item_key, kind, compat(호환/깨짐/`대조 안 함`), status, resolution | §4.12 §9.6-1-4 |
| `ci_runs` / `ci_steps` | run_key, stage, commit, ref, pr, task?, attempt?, trigger, status, fail_step, log_excerpt, artifact_path, url | §4.13 |
| `merge_queue` | pr, task unique(열림), position, status | §4.13 |
| `flaky_tests` | test_key, rate, quarantined, task | §4.13 |
| `ci_settings` | night_at, retry=1, deploy_url | §4.13 |
| `messages` | msg_key, task, attempt?, dir, type, to_agent, body, **delivery**, **pending_next**, **work_state**, fail_reason, read_at, draft — 세 상태 별도(§9.4-1) | §4.10 |
| `task_history` | 추가 전용: at, actor, task?, kind, text, before, after, ref | §4.9 §9.1-3 |
| `idempotency_keys` | unique(principal, key), request_hash, response, epoch | §9.1-6 |
| `change_events` | seq bigserial, topic, ref, at — 화면 커서. 7일 보존 [결정] | 아키텍처 2.1 |

## 3. 상태 전이

`packages/shared`에 표로 두고 서버가 강제한다(§9.1-5·7). 표에 없는 전이는 409 `INVALID_TRANSITION`. **§3.1은 G가 [미결 3]으로 둔 항목**이므로 아래는 G·P에서 도출한 추천안이며 Q-05 확인 전까지 잠정이다.

### 3.1 Task 대표 상태

| 현재 | → 다음 | 조건 · 주체 |
|---|---|---|
| (없음) | `planning` | 수동 생성·CP add (P `newTask`) |
| (없음) | `ready` | 초기 WBS 승인(P `draftWbs`) |
| `planning` | `approval` | 명세 필수 항목 충족 |
| `approval` | `ready` / `planning` | 팀장 승인 또는 자동 정책 / 반려 |
| `ready` | `running` | 시도 claim: 선행·용량·충돌·준비·등급·정책 통과 |
| `running` | `qa` / `verifying` | dev→① 통과→QA / rework→① 통과→재검증 |
| `running` | `failed` / `paused` | 실행 실패 / 중단 |
| `failed` | `running` | 재시도 dev·rework |
| `paused` | `running` / `qa` / `verifying` | 중단된 종류로 새 시도(같은 등급) |
| `qa`,`verifying` | `gate` / `rework` / `paused` | PASS / FAIL / 중단. **BLOCKED는 상태 유지**(P `registerQa`) |
| `rework` | `running` | rework 시도 |
| `gate` | `done` | Gate 5조건 + ② 통과 + PR 병합을 서버가 같은 트랜잭션에서 판정(§5.5, §4.13) |
| `gate` | `rework` | ② 통합 실패 |
| `planning`,`approval`,`ready` | `cancelled` | CP remove, 실행 이력 없음(D-16) |

`done`·`cancelled`는 종료. 차단은 저장하지 않는 계산값. SS 선행은 `planning/approval/ready`가 아니면 충족, FS는 `done`(P `depMet` L3677). P의 SS는 `cancelled`도 시작으로 보지만, 취소된 선행은 관계가 제거되므로 [결정] 무시한다.

### 3.2 시도

`starting → running → completed | failed | interrupted` (화면: 실행 중/완료/실패/중단). `starting`에서 하위 Agent 설치가 실패하면 시도 행을 남기지 않고 job을 `SUBAGENT_INSTALL_FAILED`로 되돌린다(§7.4-4). 종료 상태는 불변.

### 3.3 메시지 전달

`Draft → Queued → Sent → Acknowledged`, `Draft/Queued → Cancelled`, `Queued/Sent → Failed → Queued(재전송)`. `pending_next`는 별도 플래그. `Acknowledged`는 작업 완료가 아니다.

### 3.4 프로젝트/초기화

`none → boot(analyzing → tech_wait → drafting → approval_wait) → active`. 어느 상태에서나 초기화 → `none` + epoch+1 + 정리 `pending`. 정리 완료 전 bootstrap job claim 금지(§4.2 L261).

### 3.5 CI · 병합 대기열

CI: `queued → run → pass | fail | skip`. 대기열: `waiting_verify → queued → checking → merged | failed | removed`.

### 3.6 Change Proposal

`draft → review → approved → applied`; `review → changes | rejected`; 자동 정책 `review → applied | held`; `held → review`. 반영은 트랜잭션 안에서 재시뮬레이션하고 문제가 있으면 `held`(§9.1-4).

### 3.7 알림

event: `open → resolved`. outbox: `queued → accepted | retry_wait | failed`. 규칙이 꺼진 동안에는 event/outbox를 만들지 않는다(§4.14 L524).

## 4. DB가 보장하는 것 / Service가 보장하는 것

| DB | Service(트랜잭션) |
|---|---|
| 자기 참조·중복 의존성, 열린 시도 1개, 단일 프로젝트, 열린 알림 키 1개, 정기 보고서 중복, 멱등 키, lo≤est≤hi, 추가 전용 | 순환(DFS + 프로젝트 advisory lock으로 동시 추가 직렬화), 차단, Gate, CP 재시뮬레이션, 충돌 묶음, 슬롯, 완료 Task 보존, 이력·알림·change_events 동시 기록 |

## 5. 초기화

1. 프로젝트 행 잠금 + `confirmName` 일치.
2. 파일 경로를 `file_delete_queue`에 기록, 정리 명령 payload(저장소·기준 커밋·브랜치)를 `runner_commands`에 기록. 기준 커밋이 없으면 저장소 정리는 명령에서 제외(§9.5-2).
3. 프로젝트 데이터 삭제. `keepSettings=false`면 설정·환경·Runner 가동 기록·메일/Telegram 설정도 삭제. **GitHub 연결은 항상 유지**(§4.2 L258), 전송 이력은 항상 삭제.
4. epoch+1, `reset_log` 추가. 1~4는 한 트랜잭션(§9.5-1).
5. 커밋 후 worker가 파일 삭제, Runner가 정리 실행. 실패는 재시도.

`keepSettings`와 무관하게 삭제: 발송·전송 이력, 보고서, 기준 일정, Task 관련 전부.

## 6. 마이그레이션 · Seed

- Drizzle schema가 개발 원본, `drizzle-kit generate` SQL을 검토 후 커밋. 트리거·권한·부분 인덱스는 custom SQL migration으로 둔다. 적용된 파일은 수정 금지.
- 이름은 시각 기반(§9.6-2-4 권장). 병렬 작업 충돌을 피하려고 **schema 변경은 M1 이후 DB 담당 한 작업씩** 병합한다.
- 검증: 빈 DB up, 직전 버전 DB up, schema drift 검사. P TASK-0004의 down SQL은 Mock Task 요구이므로 채택하지 않고, 운영 되돌림은 백업 복원 + 앞으로 고치는 migration을 쓴다 [결정].
- 부트 시 자동 migrate 금지. `db:migrate` 명령으로만 실행.
- Seed 두 가지: `system`(기본 정책·하위 Agent 정의·분할 기준), `demo`(P `MOCK` 12 Task — **테스트·화면 검증 전용**, 운영 DB에서 실행 거부).
- 추가 전용 보장 테스트: 앱 역할로 UPDATE/DELETE가 거부되는지 확인.
