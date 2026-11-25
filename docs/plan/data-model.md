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
| `file_delete_queue` | epoch, path, reason, attempts, last_error | §9.5-1 |
| `lead_sessions` / `lead_login_tokens` / `lead_credentials` | token_hash unique·만료·csrf / 1회용 hash·만료·used_at / 비밀번호 hash(LAN) | owner Q-01 |
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
| `runner_jobs` | kind, payload, state(`queued/leased/started/reconcile/done/failed/cancelled`), lease_owner, lease_until, fence int, epoch, attempts | D-03 |
| `runner_job_events` | 추가 전용: prepared·prestart_failed·started·lease_lost·reconciled·finished, code, detail — **시작 전 실패 기록** | §1.2-4 §7.4-4 |
| `execution_holds` | job unique, attempt?, epoch, host_id?, boot_id?, fence?, pgid/cgroup, task?, conflict_group?, agent, slots, heavy, **slot_state**, **lock_state**, lock_from_job?, handed_to_job?, release_proof(`no_process/group_empty/boot_changed`), closed_at. 별도 `state` 컬럼 없음 — 정의는 §2.5-1. 닫히기 전 삭제 금지(초기화는 §5) | §6.7 L795·804-806 |
| `external_write_authority` | 단일 행: host_id, generation, state(`granted/blocked`), credential_fingerprint, blocked_reason, reconciled_at — GitHub 등 공유 외부 쓰기 권한 | contracts §3.4-5 |
| `task_attempts` | attempt_key unique, job unique, task, base/head SHA, spec_revision, input_version, kind(`dev/qa/rework/reverify`), agent, status(§3.2), started/ended_at, model_id, effort, grade_adjust(kind·reason), summary, failure, tokens, resumed_from. **Task당 열린 시도 1개**(부분 unique). claim은 열린 시도뿐 아니라 **미해제 `execution_holds`(§2.5-1)**로 Task·충돌 묶음·슬롯을 판정 | §4.6 §6.6 |
| `attempt_files` | 저장소 상대 경로 | §8.2 |
| `attempt_subagents` | designated/installed/observed_used, version, def_hash, confirm(`confirmed/partial`) | §6.7-7 |
| `attempt_observations` | cli, version, grade, observed, reserved, state(`ok/unconfirmed`), pgid/cgroup 상태, at | §6.7 |
| `verifications` | attempt unique, result(`PASS/FAIL/BLOCKED`), **head_sha, spec_revision**, cmd, expected, actual — 추가 전용. 근거 무효화는 `verification_invalidations` 행으로 추가 | §4.7 |
| `defects` | def_key, verification, blocking, resolved_by_verification — **원 행은 불변, 해소는 이벤트 행** | §5.5 |
| `evidence` | task, attempt?, verification?, checklist?, kind, storage_path, sha256, size | §4.7 |

#### 2.5-1 실행 보유의 단일 정의

job 하나에 보유 행 하나. 물리 슬롯과 논리 잠금은 두 축이며 **전체 상태는 저장하지 않고 계산**한다.

| 축 | 값 | 뜻 |
|---|---|---|
| `slot_state` | `none` | 지금 잡은 슬롯 없음(최초·CLI와 ① 사이·종료) |
| | `reserved` → `active` | 용량만 예약 → 프로세스 그룹 등록·실행 |
| | `unconfirmed` | 종료를 확인하지 못함. 같은 host에서는 용량을 계속 차지 |
| `lock_state` | `none` | Task·묶음 잠금이 필요 없는 job |
| | `held` | 잠금 소유 |
| | `handed_over` / `released` | 다음 job에 인계 / 반환(종료값) |
| | `orphaned` | host 변경으로 잠금 효력만 제거, 감사용(종료값) |

- **미해제** = `slot_state ≠ none` 또는 `lock_state = held`. 둘 다 아니면 `closed_at`을 채우며, 닫힌 행은 다시 열지 않는다.
- 슬롯 전이: `none→reserved→active→none`, `reserved→none`, `reserved/active→unconfirmed→none`. `none`으로 가려면 release_proof 필요. CLI 재기동은 `none→reserved→active`를 다시 밟는다.
- 잠금 전이: `none→held`(claim), `held→handed_over/released/orphaned`. `released`는 같은 host에서 `slot_state=none`일 때만, `handed_over`도 이전 job의 `slot_state=none`일 때만 가능.
- host 변경: 이전 host 행은 `lock_state=orphaned`, 남은 슬롯은 `unconfirmed`. 새 host의 용량·잠금 계산에서 제외하고 이전 host 정리 대상으로 남긴다. 외부 쓰기는 contracts §3.4-5.
- 부분 unique(모두 `WHERE lock_state='held'`): `(task)` 그리고 `conflict_group IS NOT NULL`인 `(conflict_group)`. 슬롯 상태는 이 조건에 넣지 않으므로 `unconfirmed`여도 잠금이 남는다. 열린 시도 unique와 별개.
- 용량 합계: 현재 host에서 `slot_state IN (reserved, active, unconfirmed)`인 행의 `slots`(하위 Agent 보유 계산 포함).

**인계와 자기 보유**

1. 인계는 한 트랜잭션: 이전 행 `held→handed_over, handed_to_job=B` → B의 보유 행을 `lock_state=held, slot_state=none, lock_from_job=A, host/fence=null`로 생성. 사이에 다른 claim이 끼지 못한다.
2. **자기 보유 = `hold.job = 요청 job`**이고 epoch가 같은 행. claim은 자기 행의 `held` 잠금을 충돌에서 제외하고, 그 행에 host·fence를 기록하며 `slot_state none→reserved`로 바꾼다(새 행을 만들지 않음). 인계 없는 최초 claim은 새 행을 만든다.
3. `start`·`slots/acquire`·`release`는 자기 행이면서 host·fence가 일치해야 한다(낡은 fence의 release 예외는 contracts §3.2-4). 자기 슬롯은 용량에서 한 번만 세고 타 job 행은 모두 검사한다.
4. B가 claim 전에 취소되면 B의 잠금을 `released`로 닫는다. 이전 job A는 인계 뒤 자기 보유로 인정되지 않는다.

### 2.6 Runner · 정책

| 테이블 | 주요 컬럼 | 근거 |
|---|---|---|
| `runner_sessions` | started_at, ended_at, end_reason, last_heartbeat_at — 종료 1회 외 불변 | §8.2 |
| `runner_hosts` | host_id, cpu, cores, mem/swap/disk, os, per_session_gb, samples, seen_at(이력) | §6.6 |
| `runner_concurrency_log` | limit, running, subagents(관측/보유), heavy, resources, adjust(from/to/reason) | §6.6 |
| `concurrency_settings` | mode(auto/manual), caps, mem_reserve_gb, subagent_budget(dev/qa) | §6.6 §6.7 |
| `runner_readiness` | key, status, detail, fix, at | §7.4 |
| `agent_usage` | agent, remain_pct(0~100), reset_at, tokens_used | §6.2 |
| `agent_models` / `agent_efforts` | 보고값, rank, allowed(신규=false), is_new / **CLI×모델별** 값→공통 1~5 명시 매핑(owner Q-06 승인표, ultra·미확인은 미매핑=사용 안 함) | §7.2 |
| `exec_policy` | on_usage, low_pct, on_rework, esc_notify, floors, live_inject, auto_retry_limit=2, auto_rework_limit=3 | §7.3, owner Q-04 |
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
| `mail_settings`/`mail_recipients` | SMTP(비밀값은 secrets) / email lower unique, daily/weekly 하나 이상 또는 inactive. 외부 수신자·링크 제외 필드는 Q-13에서 필요할 때 추가 | §4.11 |
| `mail_outbox` / `mail_log` | delivery_id(논리 발송), epoch, unique(report, recipient, try_no), state(§3.7) / 수신자 삭제 후에도 주소 보존 | §9.6-6 |
| `notify_settings`/`notify_rules` | enabled, chat_id, target_name, bot, 테스트 입력 지문 / 이벤트 6종 | §4.14 |
| `notify_events` | dedup_key, resolved_at, dup_count. **열린 키 1개**(부분 unique where resolved_at is null) | §8.7 |
| `notify_outbox` / `notify_log` | delivery_id, epoch, 대기·시도·next_at / 업무·테스트, 상태, 오류 요약 | §8.7 |
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
| `ci_runs` / `ci_steps` | run_key, stage, **base_sha, head_sha, merge_sha, tree_sha, pipeline_sha**(단계별 해당 값), ref, pr, task?, attempt?, trigger, status, fail_step, log_excerpt, artifact_path, url | §4.13 |
| `merge_queue` | pr, task unique(열림), position, status, qa_head_sha(H), synced_head_sha(H'), base_sha(A), verification, ci_run, tested_tree_sha, **actual_merge_sha·actual_tree_sha** | §4.13 |
| `flaky_tests` | test_key, rate, quarantined, task | §4.13 |
| `ci_settings` | night_at, retry=1, deploy_url | §4.13 |
| `messages` | msg_key, task, attempt?, dir, type, to_agent, body, **delivery**, **pending_next**, **work_state**, fail_reason, read_at, draft — 세 상태 별도(§9.4-1) | §4.10 |
| `task_history` | 추가 전용: at, actor, task?, kind, text, before, after, ref | §4.9 §9.1-3 |
| `idempotency_keys` | unique(principal, key), request_hash, response, epoch | §9.1-6 |
| `change_events` | seq bigserial, topic, ref, at — 화면 커서. 7일 보존 [결정] | 아키텍처 2.1 |

## 3. 상태 전이

`packages/shared`에 표로 두고 서버가 강제한다(§9.1-5·7). 표에 없는 전이는 409 `INVALID_TRANSITION`. §3.1은 G [미결 3]에 대해 **owner가 승인한 표**다(Q-05, 2026-11-25). 바꾸려면 owner 승인이 필요하다.

### 3.1 Task 대표 상태

| 현재 | → 다음 | 조건 · 주체 |
|---|---|---|
| (없음) | `planning` | 수동 생성·CP add (P `newTask`) |
| (없음) | `ready` | 초기 WBS 승인(P `draftWbs`) |
| `planning` | `approval` | 팀장 착수 승인 요청 + 명세 필수 항목 충족(contracts §2.5). 자동 전이 없음 |
| `approval` | `ready` / `planning` | 팀장 착수 승인(owner Q-02) / 반려 |
| `ready` | `running` | 팀장 시작 → claim 예약 → 설치 → `start` 재검사 통과 |
| `running` | `qa` / `verifying` | dev→① 통과→QA / rework→① 통과→재검증 |
| `running` | `failed` / `paused` | 실행 실패 / 중단(보유 해제와 별개) |
| `failed` | `running` / `qa` / `verifying` | 실패한 시도와 **같은 종류**의 새 시도 |
| `paused` | `running` / `qa` / `verifying` | 중단된 종류로 새 시도(같은 등급. 모델 허용 해제 시 재판단한 새 등급, D-29) |
| `qa`,`verifying` | `gate` / `rework` / `paused` / `failed` | PASS / FAIL / 중단 / QA 프로세스 자체 실패. **BLOCKED는 상태 유지**(시도는 completed, verif=blocked, P `registerQa`) |
| `qa` / `verifying` | 같은 상태 | BLOCKED 뒤 원인 해결 → **새 qa/reverify 시도·새 검증**. 기존 검증은 불변 |
| `rework` | `running` | rework 시도 |
| `gate` | `verifying` | 검증 뒤 head SHA·명세 revision이 바뀜 → 근거 무효, 재검증 |
| `gate` | `done` | Gate 5조건 + 현재 head에 유효한 QA + ② 통과 + 검사한 병합본과 실제 병합 일치를 서버가 같은 트랜잭션에서 판정(§5.5, §4.13). 「필요한 승인」은 **착수 승인**(`planning_approved_at`)이며 별도 완료 승인 없음(owner Q-02) |
| `gate` | `rework` | ② 통합 실패·병합 충돌 |
| `planning`,`approval`,`ready` | `cancelled` | CP remove, 실행 이력 없음(D-16) |

`done`·`cancelled`는 종료. 차단은 저장하지 않는 계산값. SS 선행은 `planning/approval/ready`가 아니면 충족, FS는 `done`(P `depMet` L3677). **시작 전 취소된 선행의 SS 관계는 취소 반영 트랜잭션에서 제거**하고 제거 이력·후속 차단 재계산을 남긴다(owner 2026-11-25, D-27). P의 SS 판정과 달리 `cancelled`는 시작으로 세지 않는다. 다른 선행이 미충족이면 후속은 계속 차단된다. FS도 P `simulate`처럼 관계를 제거한다.

#### 시도 종류별 claim 허용

공통: 열린 시도 없음, Task·충돌 묶음에 **다른 job의** `held` 잠금 없음(자기 보유·타 PC 예외는 §2.5-1), 정리 대기 없음.

| Task 상태 | 허용 종류 | 추가 조건 |
|---|---|---|
| `ready` | dev | 선행 충족 + **팀장 시작 버튼** |
| `rework` | rework | 최근 검증 FAIL 또는 통합 실패. 자동 3회까지, 초과는 팀장 버튼 |
| `qa` | qa | ① 통과, 최초 또는 직전 qa가 BLOCKED |
| `verifying` | reverify | rework의 ① 통과, 직전 reverify가 BLOCKED, 또는 근거 무효화 |
| `paused` | 중단된 종류 | 직전 시도 interrupted, 같은 등급. 모델이 허용 해제됐으면 재판단 완료 후 새 등급 + 이력(D-29). 재개는 팀장 버튼(P) |
| `failed` | 실패한 종류 | 직전 시도 failed. 같은 종류 연속 실패에 자동 재시도 2회(최초 포함 총 3회), 이후 팀장 버튼 |
| 그 외 | 없음 | 409 |

### 3.2 시도와 시작 전 실패

`running → completed | failed | interrupted` (화면: 실행 중/완료/실패/중단). 종료 상태는 불변. **claim은 job 예약만 하고 시도를 만들지 않는다.** 하위 Agent 설치까지 성공한 뒤 `jobs/:id/start`가 시도를 만들고 Task를 전이한다.

설치 실패(§7.4-4): 시도 행 없음, Task 상태 불변, job `failed(SUBAGENT_INSTALL_FAILED)`, `runner_job_events`와 이력에 시작 전 실패를 추가. 실행한 프로세스가 없으면 `no_process`, 설치용 프로세스가 있었으면 그룹 empty 확인 후 보유 해제. 「다시 시도」는 새 job.

### 3.3 메시지 전달

`Draft → Queued → Sent → Acknowledged`, `Draft/Queued → Cancelled`, `Queued/Sent → Failed → Queued(재전송)`. `pending_next`는 별도 플래그. `Acknowledged`는 작업 완료가 아니다.

### 3.4 프로젝트/초기화

`none → boot(analyzing → tech_wait → drafting → approval_wait) → active`. 어느 상태에서나 초기화 → `none` + epoch+1 + 정리 `pending`. 정리 완료 전 bootstrap job claim 금지(§4.2 L261).

### 3.5 CI · 병합 대기열

CI: `queued → run → pass | fail | skip`. 대기열: `waiting_verify → queued → checking → merged | failed | removed`.

### 3.6 Change Proposal

`draft → review → approved → applied`; `review → changes | rejected`; 자동 정책 `review → applied | held`; `held → review`. 반영은 트랜잭션 안에서 재시뮬레이션하고 문제가 있으면 `held`(§9.1-4).

### 3.7 알림

event: `open → resolved`. outbox(메일·Telegram 공통): `queued → sending → accepted | retry_wait | failed | unknown`, `retry_wait → sending`. 화면에는 G의 4상태만 쓰고 unknown은 「실패 — 수락 여부 불명」으로 표시(§4.14 L558). 정책은 contracts §4.4. 규칙이 꺼진 동안에는 event/outbox를 만들지 않는다(§4.14 L524).

## 4. DB가 보장하는 것 / Service가 보장하는 것

| DB | Service(트랜잭션) |
|---|---|
| 자기 참조·중복 의존성, 열린 시도 1개, 단일 프로젝트, 열린 알림 키 1개, 정기 보고서 중복, 멱등 키, lo≤est≤hi, 추가 전용 | 순환(DFS + 프로젝트 advisory lock으로 동시 추가 직렬화), 차단, Gate, CP 재시뮬레이션, 충돌 묶음, 슬롯, 완료 Task 보존, 이력·알림·change_events 동시 기록 |

## 5. 초기화

1. `system_state` 행 `FOR UPDATE` → 프로젝트 행 잠금 + `confirmName` 일치(§5.1).
2. 해당 epoch 디렉토리 전체를 `file_delete_queue`에 기록, 정리 명령 payload(저장소·기준 커밋·브랜치)를 `runner_commands`에 기록. 기준 커밋이 없으면 저장소 정리는 명령에서 제외(§9.5-2).
3. 프로젝트 데이터 삭제. `keepSettings=false`면 설정·환경·Runner 가동 기록·메일/Telegram 설정도 삭제. **GitHub 연결은 항상 유지**(§4.2 L258), 전송 이력은 항상 삭제.
4. epoch+1, `reset_log` 추가. 1~4는 한 트랜잭션(§9.5-1).
5. 커밋 후 worker가 파일 삭제, Runner가 정리 실행. 실패는 재시도. 보유 중인 실행 목록(pgid·cgroup·host·boot)은 정리 명령 payload로 옮겨, 그룹 종료가 확인되어야 정리 완료로 본다.

### 5.1 epoch 원자성

- **모든** 변경 트랜잭션(팀장·Runner·worker, 환경 행 포함)은 첫 문장으로 `system_state`를 `FOR SHARE`로 잠그고 epoch를 다시 확인한다. 초기화만 `FOR UPDATE`. middleware 검사만으로 쓰지 않는다.
- 잠금 순서: `system_state → projects → tasks(id순) → jobs/holds → 그 외`. 역순 금지.
- worker 작업은 생성 시 epoch를 갖는다. 시작과 결과 반영 때마다 잠금 안에서 epoch를 재확인하고, 낡으면 결과를 버린다.
- 파일은 `<epoch>/` 아래에 쓴다. 삭제 작업은 그 epoch의 worker 임대가 끝나거나 만료된 뒤 실행하고, 만료된 worker가 뒤늦게 쓴 파일은 낡은 epoch 디렉토리 재검사로 지운다.
- 발송은 `sending` 전이를 잠금 안에서 확정한 뒤 잠금 밖에서 수행한다. 초기화는 `queued/retry_wait`를 취소한다. **이미 외부로 전송을 시작한 요청은 회수할 수 없으므로** 이력 삭제와 별개로 확인 창에 알린다.

`keepSettings`와 무관하게 삭제: 발송·전송 이력, 보고서, 기준 일정, Task 관련 전부.

## 6. 마이그레이션 · Seed

- Drizzle schema가 개발 원본, `drizzle-kit generate` SQL을 검토 후 커밋. 트리거·권한·부분 인덱스는 custom SQL migration으로 둔다. 적용된 파일은 수정 금지.
- 이름은 시각 기반(§9.6-2-4 권장). 병렬 작업 충돌을 피하려고 **schema 변경은 M1 이후 DB 담당 한 작업씩** 병합한다.
- 검증: 빈 DB up, 직전 버전 DB up, schema drift 검사. P TASK-0004의 down SQL은 Mock Task 요구이므로 채택하지 않고, 운영 되돌림은 백업 복원 + 앞으로 고치는 migration을 쓴다 [결정].
- 부트 시 자동 migrate 금지. `db:migrate` 명령으로만 실행.
- Seed 두 가지: `system`(G가 확정한 기본 정책·분할 기준, owner 확정 Q-03 값·Q-04(자동 재시도 2·재작업 3)·Q-06 매핑, 검토를 마친 하위 Agent v1 — M5-06), `demo`(P `MOCK` 12 Task·`SUB_MOCK`·Q 미승인 잠정값 — **테스트·화면 검증 전용**, 운영 DB에서 실행 거부).
- 추가 전용 보장 테스트: 앱 역할로 UPDATE/DELETE가 거부되는지 확인.
