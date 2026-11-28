# Agent WBS 구현 기준선 — 데이터 모델

> **이 문서가 답하는 질문**
> - DB에 어떤 테이블이 있고, 각 테이블은 무엇을 담나?
> - Task·시도·변경 제안 같은 것들의 상태는 어떤 순서로 바뀌나?
> - 초기화(프로젝트 전체 지우기)는 어떻게 안전하게 하나?
>
> 처음 읽는다면 [docs/README.md](../README.md)부터 보세요. 낯선 용어는 [용어집](../glossary.md)에 있습니다.

**읽기 전에**

- 표기는 [architecture.md](architecture.md)와 같다. (G = 가이드, P = 프로토타입, `L` = 줄 번호, `§` = 가이드 절)
- 논리 객체는 G§5.1, 물리 테이블 구분은 [결정]이다.
  - 논리 객체는 「Task」「시도」처럼 업무에서 쓰는 개념이고, 물리 테이블은 그것을 실제 DB에 어떻게 나눠 담을지다.
- 컬럼은 주요 항목만 적었고 최종 타입은 M1 마이그레이션(DB 구조를 바꾸는 SQL 파일)에서 고정한다.
  - 용어 풀이: SQL = DB에 묻고 고치는 언어.

## 1. 공통 규칙

모든 테이블에 똑같이 적용하는 규칙이다.

- **ID 두 가지**
  - PK `uuid`(DB 생성)를 쓴다. PK(기본 키)는 행을 구분하는 내부 번호다.
  - 표시 ID(`TASK-0007`, `ATT-0007-2`, `CP-001`, `RP-004`, `CI-0118`, `TD-03`)는 별도 unique 컬럼이다.
  - **참조는 Task ID**(§9.1-1), FK는 내부 uuid. (FK는 다른 테이블의 행을 가리키는 열이다.)
  - 왜 둘로 나누나: 사람이 읽는 번호와 DB가 연결에 쓰는 번호를 분리하면, 표시 형식을 바꿔도 연결이 깨지지 않는다.
- **표시 ID 순번**
  - `counters(project_id, kind, value)`를 트랜잭션 안에서 증가. 재사용하지 않는다.
  - 시도 번호는 Task별.
  - 왜 재사용하지 않나: 지운 번호를 다시 쓰면 옛 이력과 새 Task가 같은 번호로 헷갈린다.
- **시각과 날짜**
  - 시각 `timestamptz`(시간대를 반영해 UTC의 한 시점으로 저장하는 타입. 원래 시간대 정보는 보관하지 않는다), 날짜만 의미 있는 값(목표일·작업 불가일)은 `date`.
- **수정 추적**
  - 변경 가능한 행: `created_at`, `updated_at`(단조 증가). 단조 증가는 「항상 커지기만 한다」는 뜻이다.
  - 수정 API는 `updatedAt` 비교(§0.3 L73).
  - 왜: 두 사람이 같은 행을 동시에 고칠 때, 낡은 화면에서 보낸 수정을 알아채 막기 위해서다.
- **저장 순번(「최신 하나」를 고르는 기준)** (M7-04 조정자 결정 7·12, M5·M7·M6 통합)
  - 「가장 최근 것 하나」를 고르는 곳은 `created_at`(벽시계)이 아니라 **뒤로 가지 않는 저장 순번**으로 정렬한다.
  - 순번 열은 `bigserial`(자동 번호)이고 unique다. 기존 행은 순번을 처음 매길 때 그때까지의 시각 정렬 순서대로 번호를 받았다.
  - 순번이 있는 표
    - `record_no`(마이그레이션 0026): `planning_jobs`, `task_estimates`, `change_proposals`, `runner_jobs`, `task_attempts`, `attempt_observations`, `runner_hosts`, `runner_concurrency_log`, `agent_usage`, `task_history`, `ci_steps`, `runner_sessions`.
    - `record_no`(0027): `change_proposal_events`, `planning_job_logs`, `planning_reviews`.
    - `record_no`(0037): `notify_outbox`, `reports`, `design_drifts`.
    - `run_no`(0026): `ci_runs`. `queue_no`(0026): `merge_queue`.
  - 왜: 이 PC(WSL)의 시계는 실제로 몇 초씩 뒤로 간다. 그러면 `created_at` 순서가 저장 순서와 달라져, Gate가 옛 ① 기록을 「최신」으로 고르는 간헐 실패가 생겼다.
  - 화면 목록의 `created_at desc` 페이지 정렬은 아직 그대로다. 시계가 뒤로 가면 순서만 바뀔 수 있다.
- **project_id**
  - 프로젝트 데이터는 모두 `project_id`(단일 프로젝트지만 초기화 삭제 기준).
  - 설정·환경은 `project_id` 없음.
  - 프로젝트를 등록하기 전에도 써야 하는 표는 `project_id`에 null을 허용한다.
    - 대상: 멱등 키(`idempotency_keys`), 변경 이벤트(`change_events`), 이력, 알림(`notify_events`·`notify_outbox`·`alerts` 등).
    - null은 「프로젝트 없는 범위(전역)」라는 뜻이다. unique 검사에서도 프로젝트 범위와 전역을 따로 센다(§2.7·§2.8).
    - 왜: 등록 전 저장소 확인이나 시스템 알림도 기록해야 하는데, 그때는 가리킬 프로젝트가 아직 없다.
- **삭제**
  - FK 기본 `ON DELETE RESTRICT`. (가리키는 행이 있으면 지우지 못하게 막는다.)
  - 이력·추가 전용·실행 기록은 초기화 함수에서만 물리 삭제한다.
  - 계약에 삭제 API가 있는 비이력 관계·설정·토큰은 아래 표에서만 앱이 직접 삭제할 수 있다. 삭제하는 트랜잭션에서 이력을 함께 남긴다.
    - 표: `task_dependencies`, `checklist_items`, `task_specs`, `task_designs`, `task_outputs`, `task_grades`, `task_subagents`, `task_design_items`, `task_source_links`, `mail_recipients`, `blackout_days`, `lead_sessions`, `lead_login_tokens`, `lead_credentials`, `runner_tokens`, `secrets`, `file_delete_queue`.
    - 쓰이는 곳의 예: 의존성 삭제(`DELETE /api/dependencies/:id`), 체크리스트 삭제, 등급 해제, 수신자 삭제, 로그아웃·토큰 폐기, 파일 삭제 worker의 성공 처리.
    - 예: 선행 관계 삭제는 허용하지만 Task 이력 삭제는 금지다.
  - `change_events`는 7일 보존 정리 함수로만 지운다.
  - Task는 `deleted_at` soft delete, CP 취소는 `cancelled`. soft delete는 행을 지우지 않고 「지움」 표시만 하는 방식이다.
  - 왜: 이력과 연결을 잃지 않기 위해서다. 다만 의존성처럼 「지우는 것」 자체가 기능인 행까지 막으면 계약의 삭제 API를 만들 수 없다.
- **값 종류**
  - 값이 고정된 종류는 PostgreSQL(관계형 데이터베이스) enum.
  - 자주 늘어날 종류(알림 사유·이력 유형)는 text + CHECK(값이 조건을 만족하는지 DB가 검사하는 제약).
  - 왜: enum은 값을 추가할 때 마이그레이션이 번거롭다. 자주 늘어나는 것은 text가 편하다.
- **자유 구조 데이터**
  - 구조가 자유로운 명세·스냅샷(어느 순간의 데이터를 그대로 찍어 둔 것)은 `jsonb` + 쓰기 시 TypeBox 검증 + `schema_version`.

## 2. 테이블

각 테이블은 「`테이블 이름` — 주요 컬럼·제약 (근거)」 형식으로 적었다.

### 2.1 시스템 · 인증 (초기화와 무관)

여기 테이블은 프로젝트를 초기화해도 지워지지 않는 시스템 기록과 로그인 정보다.

- `system_state`
  - 단일 행(`id=1` CHECK), `epoch int`, `cleanup_status(none/pending/running/failed)`, created_at/updated_at
  - 근거: §4.2 L261
- `reset_log`
  - epoch, at, actor, deleted_task_count, keep_settings, runner_cleanup_status, finished_at — 프로젝트와 별도 보존
  - 근거: §4.2 L258
- `runner_commands`
  - kind(`reset-cleanup`), epoch, payload(저장소·기준 커밋·브랜치·경로), status, attempts, result
  - 앱은 이 표에 직접 INSERT·UPDATE하지 못한다.
    - 명령은 초기화 함수(`reset_project()`)만 만들고, 결과는 `complete_cleanup()`만 기록한다.
    - `complete_cleanup()`은 명령의 epoch와, 보유별 정리 증거가 기록된 보유와 맞는지를 확인한다(§5).
    - 왜: 정리 명령은 「낡은 실행이 정말 끝났다」는 증거다. 앱 코드가 마음대로 고치면 증거를 믿을 수 없다.
  - 근거: §8.4
- `file_delete_queue`
  - epoch, path, reason, attempts, last_error
  - 근거: §9.5-1
- `lead_sessions` / `lead_login_tokens` / `lead_credentials`
  - `lead_sessions`: token_hash unique·만료·csrf
  - `lead_login_tokens`: 1회용 hash·만료·used_at
  - `lead_credentials`: 비밀번호 hash(LAN)
  - 근거: owner Q-01
- `runner_tokens`
  - token_hash unique, runner_id, public_key, revoked_at
  - 근거: §8
- `secrets`
  - key PK, ciphertext(암호화된 값), nonce(암호화할 때 한 번만 쓰는 난수), key_version, last4, created_at/updated_at
  - 근거: §8.7

### 2.2 프로젝트 · 입력

- `projects`
  - 단일 행 보장 unique(`singleton=true`), name, repo_url/owner/name, branch=`main`, base_commit, target_date?, lead_instruction, phase(`boot/active`)
  - 근거: §4.2
- `repo_checks`
  - url, status, result(jsonb: private·commit·구조), error — 등록 전 생성 가능(project_id null)
    - 용어 풀이: private = 허가된 사람만 볼 수 있는.
    - 용어 풀이: commit = 확인한 커밋의 고유 번호(SHA).
  - 근거: §8.4
- `input_versions`
  - unique(project, v), commit_sha unique(project), files, md_list, changes, instruction — 추가 전용
  - 분석 결과는 이 행에 두지 않고 `input_version_results`에 따로 추가한다.
  - 근거: §4.2 L246
- `input_version_results`
  - input_version unique, result(jsonb), project_id, schema_version — 추가 전용
  - 왜 따로 두나: 분석하기 전에 입력을 먼저 고정하고, 분석 결과는 나중에 덧붙이기 위해서다. 한 행에 두면 결과를 쓸 때 고정된 입력 행을 고쳐야 한다.
  - 근거: §4.2 L246
- `input_change_commits`
  - unique(project, sha), files, state(`pending/skipped/analyzed`), analyzed_in_version
  - 근거: §4.2 ②
- `planning_jobs`
  - kind(`bootstrap/input_diff/planning/estimate/split`), run_no, status, fail, instruction — 프로젝트당 열린 bootstrap 1개(부분 unique)
  - 부분 unique: 조건을 만족하는 행들 사이에서만 겹치지 않게 하는 제약이다.
  - 근거: §4.2 §8.4
- `planning_job_steps`
  - job, step_key, status(`wait/run/done/fail`), note, started/finished_at
  - 근거: §0.3
- `planning_job_logs`
  - 추가 전용
  - 근거: §0.3
- `wbs_drafts`
  - job, revision, content(jsonb), split_check, status — 승인 전 WBS 미반영
  - 근거: §4.2 L237

### 2.3 WBS · Task

- `wbs_nodes`
  - kind(`phase/work_package`), parent_id, title, sort_order. CHECK: phase는 parent 없음
  - 부모 규칙: Phase → Work Package → Task 순서다.
    - Work Package의 부모는 같은 프로젝트의 Phase여야 한다.
    - Task의 부모(`tasks.wbs_node_id`)는 같은 프로젝트의 Work Package여야 한다.
    - 노드의 kind와 project는 만든 뒤 바꾸지 않는다.
  - 근거: P TASK-0004
- `tasks`
  - task_key unique, wbs_node_id, sort_order, title(1~200), work_type, primary_domain, related_domains[], priority(0~3), assignee/verifier_agent, **status**(§3.1), verif_state, planning_approved_at, fix_start, act_start/act_end, conflict_group, src_input_version, deleted_at.
  - CHECK `primary_domain <> ALL(related_domains)`.
  - CHECK: `related_domains`에 NULL 원소 금지.
  - `wbs_path`는 저장하지 않고 계산(§9.1-1).
  - 근거: §5.2 §5.3
- `task_specs`
  - task PK, overview(jsonb: 목적·배경·범위·제외·선행/완료 조건), spec(jsonb: req·work·steps·inputs·outputs·files·constraints·errors·docs·verify), ac(jsonb[] given/when/then/method)
  - AC(Acceptance Criteria)는 「이렇게 되면 완료로 인정한다」는 수용 기준이다.
  - 근거: §4.4, P `SPEC_GROUPS`
- `task_outputs`
  - name, kind, required, verify, delivered, delivered_attempt, unique(task, name)
  - 근거: §5.5
- `task_designs`
  - task, kind(`DB/API/FE/DevOps`), content(jsonb, P `DESIGN` 스키마)
  - 근거: §4.4
- `task_design_items`
  - task, item_key(`METHOD path`, `store:name`, 토픽, 키 패턴), change — 충돌 묶음·불일치 공용 키
  - 근거: §9.6-1-2
- `task_dependencies`
  - pred, succ, dep_type(`FS/SS`), unique(pred,succ), CHECK pred≠succ
  - pred는 선행 Task, succ는 후속 Task다. FS는 「선행이 끝나야 후속 시작」, SS는 「선행이 시작되면 후속 시작 가능」이다.
  - 근거: §5.4
- `checklist_items`
  - item_key, content, required, done, verify_method, evidence, note, sort_order, unique(task,item_key)
  - 근거: §4.4
- `task_estimates`
  - 추가 전용: est/lo/hi hours(`lo<=est<=hi` CHECK), tokens_k, confidence, basis, agreed_by
  - est는 예상, lo는 낙관(짧게), hi는 비관(길게) 추정이다.
  - 근거: §8.3
- `task_grades`
  - role(`dev/qa`), model_id, effort, reason, locked, locked_by, effective_from
  - 현재 등급은 unique(task, role): 같은 Task에 같은 역할의 등급을 두 개 저장하지 못한다.
  - 근거: §7.1
- `task_subagents`
  - role, subagent_id, basis
  - 근거: §7.4
- `task_splits`
  - Task당 1행: unique(task).
  - basis(분할 근거 text). CP add의 `t.splitBasis`·초안 `splitBasis`에서 저장한다.
    - 일반 CP에서 생략하면 빈 문자열 = 미기록이다.
    - P L4056처럼 문구를 자동 합성하지 않음.
    - 왜: 근거가 없는데 그럴듯한 문장을 지어 넣으면, 판단한 적이 없는 분할이 판단한 것처럼 보인다.
  - judged_rules(jsonb, §2.3-1)
  - exceptions(jsonb: rule·why·by·at)
  - 근거: §5.2-1
- `task_source_links`
  - fix_task → origin_task(버그 수정), split_from
  - 근거: §5.2-1 L622

#### 2.3-1 `judged_rules` 정의 (D-33)

**배경**: 분할 기준 중 규칙 5·7·9는 기계가 판정할 수 없고 Planning(Claude·Codex 두 Agent)이 판단해야 한다. 그래서 「누가, 무엇을 보고, 어떤 결론을 냈는지」를 아래 형식으로 기록한다. 기록이 없거나 결론이 「불충족」이면 승인을 보류한다.

```ts
type JudgedRules = {
  schemaVersion: 1;
  items: Judgement<'revert' | 'contract' | 'refactor'>[];   // 규칙 5·7·9, rule별 최대 1건
};
type SplitJudgements = {                                    // 분할 CP (D-34)
  schemaVersion: 1;
  items: Judgement<'ac_meaning' | 'layer_order' | 'test_included'>[];
};
type Judgement<R> = {
  rule: R;
  result: 'met' | 'not_met';          // 충족 | 불충족
  agreedBy: ('Claude' | 'Codex')[];   // 합의 주체. 중복 없이 둘 다 필요
  basis: string;                      // 근거, 공백 제거 후 1자 이상
  subjectHash: string;                // 판단 대상의 정규화 SHA-256
  judgedAt: string;                   // UTC ISO 8601
  sourceRef: string;                  // planning job/session ID
};
```

**누가 쓰나**

- 기록은 Planning API만 쓴다.
- 다시 판단하면 최신값으로 바꾸고 이전·이후를 `task_history`에 추가한다.

**`subjectHash`(판단 대상의 지문)는 무엇으로 계산하나**

hash는 내용을 짧은 문자열로 줄인 지문이다. 내용이 조금이라도 바뀌면 지문도 바뀐다. 판단할 때의 지문을 같이 적어 두면, 나중에 내용이 바뀌었는지 바로 알 수 있다.

- 대상:
  - `judged_rules`는 아래 `JudgedContent`로 계산한다.
  - `split_judgements`는 판단 기록을 뺀 CP `ops` **전체** + 각 대상 Task의 현재 `JudgedContent`로 계산한다.
- `JudgedContent` = `{title, scope[], out[], doneCond, spec, ac[], outputs[{name,kind,required,verify}], designs[{kind,content}], conflictGroup}`
  - 뜻: 제목·범위·제외·**완료 조건**·명세(`task_specs.spec`)·AC·산출물·기술 설계·충돌 묶음.
- **완료 조건이 바뀌면 판단의 전제가 바뀌므로 포함**하며 `doneCond`만 바꾸는 CP도 다시 판단한다.
- 제외하는 것:
  - 목적·배경·선행 조건
  - 산출물 제출 여부(`delivered`)
  - Task의 우선순위·담당·상태 (단 분할 hash의 `ops`에 든 새 Task 값은 포함)
- **계산은 서버만** 한다.
  - 새 Task·초안·CP는 내용과 판단을 함께 받아 저장 때 계산하므로 요청에서 생략한다.
  - 기존 Task 재판단은 작업 payload로 받은 값을 그대로 돌려보내 불일치를 검출한다.
  - 저장된 CP의 판단(`/planning/proposals/:id/judgements`)도 같다.
- 판단 기록 자체(`judgedRules`·`taskJudgements`·`splitJudgements`)와 Task 키·ref는 hash 대상에서 **제외**한다.
  - 왜: 자기 참조 방지. NEW-n→TASK-n 변환에도 동일하다. (판단을 적으면 hash가 바뀌고, 그러면 판단이 낡아지는 일이 생기지 않게 한다.)

**`subjectHash` 계산 규칙** (M2-02 독립 리뷰 §5, 지금 구현 `apps/api/src/tasks/hash.ts`와 같음)

「정규화한 JSON」이라고만 쓰면 구현마다 값이 달라질 수 있다. 그래서 바이트 단위까지 아래처럼 고정한다.

1. 위 `JudgedContent` 필드만 고른다. 제외 목록(목적·배경·선행 조건·담당·우선순위·상태·`delivered`·Task 키/ref·판단 기록)은 넣지 않는다.
2. `spec`은 `req, work, steps, inputs, outputs, files, constraints, errors, docs, verify` 10개 키를 모두 가진다.
   - 저장된 명세에 빠진 칸은 빈 목록 `[]`로 채운다.
   - `conflictGroup`이 없으면 `null`이다.
3. 배열 순서:
   - `scope`·`out`·`spec`의 각 목록·`ac`는 저장된 순서를 그대로 둔다.
   - 산출물(`outputs`)은 `name`의 문자열 비교 순서(UTF-16 코드 단위 순서, JavaScript 기본 비교)로 정렬하고 `{name,kind,required,verify}`만 남긴다.
   - 설계(`designs`)는 DB → API → FE → DevOps 순서다.
4. 모든 객체의 키는 재귀적으로 같은 UTF-16 순서로 정렬한다. 값이 `undefined`인 키는 뺀다.
   - JSON에 공백·들여쓰기·끝 줄바꿈을 넣지 않는다.
   - 문자열 escape(따옴표·줄바꿈 같은 특수 문자를 JSON에 적는 방식)와 숫자 표기는 JavaScript `JSON.stringify` 규칙을 따른다.
5. 문자열에 앞뒤 공백 제거(trim)·대소문자 변환·줄바꿈 통일·Unicode 정규화(NFC/NFD, 겉모양이 같은 글자의 서로 다른 문자 표현을 하나로 맞추는 처리)를 하지 않는다. 공백이나 Unicode 표현 차이도 내용 차이다.
   - 이런 정규화를 넣고 싶다면 지금 지문과 호환되지 않으므로 규칙 버전을 바꿔야 한다.
6. 결과 JSON을 UTF-8로 인코딩해 SHA-256을 계산하고, **소문자 16진수 64자리**로 저장한다.
7. Task 승인과 Planning·CP(M2-07)가 같은 함수 하나를 부른다.
   - 왜: 같은 내용이 경로마다 다른 지문이 되면, 유효한 판단이 「기록 없음」으로 보류된다.

- 고정 벡터(입력과 정답 지문을 고정해 둔 시험 예시): 제목 `예시`, 범위 `['기능']`, 완료 조건 `테스트 통과`, 나머지는 빈 목록·null인 내용의 지문은 `49813649157306979e9b5652a52674817589723f035e668c9b8a9e372027a1cb`다(`apps/api/test/tasks.test.ts`).

**Task 판단 보고(`POST /planning/tasks/:taskKey/plan`)의 hash 처리**

- 서버는 payload에 담긴 **변경 전** `subjectHash`를 지금 Task 내용의 hash와 대조한다. 다르면 409 VERSION_CONFLICT다.
- 같은 보고에 충돌 묶음(`conflictGroup`) 판단이 함께 오면, 그 묶음을 반영한 내용으로 서버가 hash를 다시 계산해 판단 기록에 붙인다.
- 대조·반영·저장 전체를 한 트랜잭션으로 처리한다.
- 왜: 충돌 묶음도 `JudgedContent`에 들어 있다. 묶음을 바꾸고 옛 hash를 그대로 두면, 방금 한 판단이 곧바로 낡은 것이 된다.

**유효한 기록과 승인 판정**

- **유효한 기록** = 형식이 맞고 합의 주체가 둘 다이며 현재 대상 hash와 일치. 아니면 「기록 없음」으로 본다 [결정].
- 켜진 규칙마다 유효한 `met`이 있어야 승인 가능.
  - 없으면 `JUDGEMENT_MISSING`
  - `not_met`이면 `JUDGEMENT_NOT_MET`
- 자동 규칙의 예외 사유로 대신하지 않는다.
- 화면 상태는 G의 「판단」을 쓰고 충족/불충족/기록 없음을 글로 구분한다.

**저장 위치**

| 판단 대상 | 반영 전 | 반영 후 |
|---|---|---|
| CP의 새 Task | `change_proposals.ops[].t.judgedRules` | 새 Task의 `task_splits.judged_rules` |
| CP가 내용을 바꾸는 기존 Task | `change_proposals.task_judgements` = `[{taskKey, judgedRules}]`(taskKey 중복 금지) | 그 Task의 `task_splits.judged_rules` 교체 + 이력 |
| 분할 CP | `change_proposals.split_judgements` | CP에 그대로 보존 |
| 초기 초안 | `wbs_drafts.content` | `task_splits.judged_rules` |

- 반영 전에는 기존 Task의 `task_splits`를 바꾸지 않는다.
- 반영 트랜잭션에서 실제 적용 내용으로 hash를 다시 계산해 대조하고, 다르면 「기록 없음」으로 보류한다.
- CP의 기존 Task 판정은 `task_judgements` 항목이 있으면 그것을, 없으면 현재 `task_splits.judged_rules`를 쓴다. 어느 쪽이든 **변경 후 hash**와 일치해야 유효하다.
- CP 검사 대상: 추가된 Task와 hash 대상 내용이 바뀐 Task만.
  - 판단 규칙과 무관한 CP(우선순위 변경 등)는 막지 않는다.
  - 왜: 판단할 내용이 바뀌지 않았는데 승인을 막으면 일만 늘어난다.

#### 2.3-2 분할의 순서 보장 판정 (D-34)

**문제**: Task 하나를 여러 개로 나누면, 원래 Task에 걸려 있던 「먼저 해야 하는 일」 관계가 나눈 Task들에 제대로 옮겨졌는지 확인해야 한다.

원래 Task T를 T1…Tn으로 나눌 때, T의 선후행 관계마다 변경 후 그래프에서 확인한다. 조사 Task가 추가되면 그래프에 포함한다.

| 원래 관계 | 변경 후 필요한 보장 |
|---|---|
| A FS T | A에서 **모든 Ti**로, 첫 변이 FS인 경로 |
| A SS T | A에서 **모든 Ti**로의 경로(FS·SS) |
| T FS B | **모든 Ti**에서 B로, 첫 변이 FS인 경로 |
| T SS B | **하나 이상의 Ti**에서 B로의 경로(FS·SS) |

- 왜 「첫 변이 FS」인가: 첫 변이 FS면 이후 변이 FS·SS여도 도착 Task 시작 ≥ 출발 Task 종료가 유지된다.
- 예: 원래 「A FS T」였고 T를 T1·T2로 나눴다면, A→T1과 A→T2 모두 FS로 시작하는 길이 있어야 한다. A→T1(FS), T1→T2(SS)처럼 간접 경로도 인정한다.
- 이미 충족된 선행(FS는 완료, SS는 시작됨)은 검사하지 않는다 [결정].
- 하나라도 보장되지 않으면 `ORDER_NOT_PRESERVED`.
- 분할이 아닌 취소 CP는 D-27을 따른다.

### 2.4 Planning · 변경 제안

- `plannings` / `planning_analyses` / `planning_reviews`
  - `plannings`: 세션
  - `planning_analyses`: Agent별 독립 분석 unique(planning, agent)
  - `planning_reviews`: 주제별 일치·이견·조정
    - `codex` = `{text, ops, common}`, `claude` = `{text, ops}`이다(jsonb).
    - `common`은 두 Agent가 함께 낸 공통 변경(ops)이다. 각자의 `ops`는 Agent별 대안이다.
    - 왜 `common`을 codex 쪽에 두나: 새 열을 만들지 않으려는 선택이다(M2-07 구현).
  - 근거: §4.5
- `change_proposals`
  - cp_key, title(공백 금지), reason(공백 금지), source(planning/message/manual/split/input/decision), source_id(출처 ID, 없으면 null), status(§3.6), ops(jsonb §5.6), id_map, preview_hash
  - **분할 CP(`source=split`)는 `source_id`에 원래 Task 키가 필수다**(제약 이름 `cp_split_source`).
    - 왜: 충돌 묶음 상속(§2.4-1)과 분할 순서 판정(§2.3-2)이 모두 「원래 Task가 무엇인가」를 기준으로 한다.
  - 이전 버전에서 저장된 행(마이그레이션 0013 전):
    - title에는 cp_key, reason에는 「이전 버전에서 저장되어 사유가 없음」을 채운다.
    - 원래 Task 키는 알 수 없으므로 지어내지 않는다. 그래서 `source_id`가 빈 분할 CP가 남을 수 있다.
    - 분할 CP의 `source_id` 필수 규칙은 새 행과 규칙을 지키던 행에 적용한다.
    - 이미 규칙을 어긴 이전 행은 출처를 그대로 둔 갱신(상태·보류 사유·제목 등)만 허용한다. 출처가 split이고 `source_id`가 빈 상태를 유지해야 한다.
    - 원래 Task 키를 나중에 채울 수는 있지만, 채운 뒤 다시 비울 수는 없다.
    - 이 규칙은 CHECK가 아니라 같은 이름의 트리거로 검사한다(0014). 어기면 오류 코드는 23514다.
    - 왜 트리거인가: CHECK는 「바뀌기 전 값」을 볼 수 없어서, 이전 행을 반려하는 것 같은 무관한 갱신까지 막았다.
  - hold_reasons(jsonb `{holdReasons,issues}`, contracts §2.1)
  - split_judgements(jsonb null, §2.3-1; 분할 CP만)
  - **task_judgements(jsonb not null default `[]`**, §2.3-1)
  - 근거: §4.8 §5.6
- `change_proposal_events`
  - 제출·승인·반려·반영·보류, actor, comment — 추가 전용
  - 근거: §4.8

#### 2.4-1 CP add Task의 선택 필드

CP(변경 제안)로 새 Task를 추가할 때 넣을 수 있는 선택 필드다. 넣지 않으면 「생략 시」 값이 쓰인다.

| 필드 | 형식(기존 Task와 같음) | 저장 | 생략 시 |
|---|---|---|---|
| `scope` | `string[]` | `task_specs.overview.scope` | `[]` (P `newTask` L3716) |
| `files` | `string[]` (Task `spec.files`와 같음) | `task_specs.spec.files` | `[]` (P `emptySpec`) |
| `design` | `[{kind:"DB"\|"API"\|"FE"\|"DevOps", content}]`, kind 중복 금지(Task `designs` 요소와 같음) | `task_designs` | 영역에 맞는 빈 구역(P `recKinds(domain, rel)`). 명시한 `[]`는 구역 없음 |
| `conflictGroup` | 공백 아닌 문자열 또는 null | `tasks.conflict_group` | 일반 CP: null(P `cg ''`). **분할 CP: 아래 상속** |

**충돌 묶음(`conflictGroup`) 규칙**

충돌 묶음은 「같은 파일·같은 설계를 건드려 동시에 실행하면 부딪치는 Task들」에 붙이는 이름이다. 같은 묶음의 Task는 한 번에 하나만 실행된다.

- `conflictGroup`은 Planning 작성 CP만 쓴다(충돌 묶음은 Planning 지정, §6.6 L741·§6.2).
  - 팀장 작성에 있으면 400.
  - 팀장 작성 분할 CP도 생략 = 상속.
- **분할의 충돌 묶음 상속**
  - 원래 Task(`source.id`)를 취소하는 분할 CP에서, 원래 Task를 대신하는 Task가 `conflictGroup`을 생략하면 **원래 Task의 묶음**을 쓴다.
  - 「원래 Task를 대신하는 Task」는 M1-05 `parts`다: 조사 Task 제외, 원래가 Analysis면 추가 Task 전부.
  - P `proposeSplit`은 묶음을 옮기지 않아 사라지므로 따르지 않는다.
    - 왜: 묶음이 사라지면 나눈 Task들이 같은 파일을 동시에 고치다 부딪칠 수 있다.
  - 조사 Task는 생략 시 null이다.
  - 원래 Task를 유지하는 조사 분할에서는 원래 Task의 묶음이 그대로다.
- 다른 묶음이나 명시한 null로 바꾸는 것은 허용한다.
  - 단 `diff`에 `field=conflictGroup`, before=원래 묶음, after=새 값을 **반드시** 남긴다.
  - 상속도 같은 묶음으로 diff에 보인다.
- 상속은 저장 때 굳히지 않고 미리보기·승인·반영 때마다 현재 원래 Task에서 계산한다.
  - 판단 hash는 생략 규칙을 적용한 뒤의 `JudgedContent`로 계산하므로 원래 묶음이 바뀌면 다시 판단한다.

**`scope`·`files`·`design`은 상속하지 않는다**

- `scope`·`files`·`design`은 원래 Task에서 상속하지 않는다.
  - 왜: 전체를 복사하면 나눈 Task마다 원래 범위·파일·설계를 모두 가진 것으로 점검됨.
- 대신 원래 Task에 변경 파일이나 설계 항목이 있는데 나눈 Task의 값이 비면, 규칙 3(파일)·2와 8(설계)을 「통과」로 보이지 않고 **「주의 — 변경 범위 미기재」**로 표시한다 [결정].
- 더 무거운 위반·의심 결과가 있으면 그것이 우선한다.
- 원래 Task의 명세는 취소 뒤에도 보존된다.
- 규칙 6은 상속을 적용한 묶음 하나로 점검한다.

### 2.5 실행 · 검증

- `runner_jobs`
  - kind, payload, state(`queued/leased/started/reconcile/done/failed/cancelled`), lease_owner, lease_until, fence int, epoch, attempts
  - fence는 낡은 Runner의 보고를 막는 번호표다. job을 새로 임대할 때마다 바뀐다.
  - dedup_key: 필수 unique. 같은 원인으로 job이 두 번 만들어지는 것을 막는 키다.
    - 새 키는 서비스가 원인 시도와 회차로 만든다.
    - 이 열이 생기기 전 행은 `legacy:<id>`로 채웠다.
  - 끝난 job(`done/failed/cancelled`)은 다시 열거나 고치지 않는다. fence는 줄어들지 않고, epoch와 dedup_key도 바꾸지 않는다.
    - 왜: 끝난 job이 되살아나거나 fence가 내려가면, 이미 거절했어야 할 낡은 보고가 다시 통과한다.
  - 근거: D-03
- `runner_job_events`
  - 추가 전용: prepared·prestart_failed·returned·started·lease_lost·reconciled·finished, code, detail — **시작 전 실패·자원 반환 기록**
  - 근거: §1.2-4 §7.4-4
- `execution_holds`
  - 같은 job의 열린 보유(`closed_at is null`)만 하나다. 닫힌 보유는 이력으로 여러 개 남을 수 있다.
  - attempt?, epoch, host_id?, boot_id?, fence?, pgid/cgroup, task?, conflict_group?, agent, slots, heavy, **slot_state**, **lock_state**, lock_from_job?, handed_to_job?, release_proof(`no_process/group_empty/boot_changed/cgroup_empty`, cgroup_empty는 마이그레이션 0040 — cgroup이 기록된 보유만, cgroup 없는 보유는 group_empty만), closed_at.
  - 왜: PC 변경으로 닫힌 보유는 불변으로 남기고, 같은 대기 job은 새 보유로 실행해야 한다.
  - 대기 job의 담당·검증 Agent가 바뀌어도 옛 행의 `agent`는 바꾸지 않는다. 다음 claim에서 옛 행을 닫고 새 행을 만든다. `runner_jobs.payload.agent`는 새 실행 Agent와 맞춘다.
  - 왜: 과거 보유를 덮어쓰지 않으면서 새 모델 등급과 실제 Agent가 맞아야 한다.
  - 별도 `state` 컬럼 없음 — 정의는 §2.5-1.
  - 닫히기 전 삭제 금지(초기화는 §5).
  - 행을 새로 만들 때(INSERT)도 §2.5-1의 상태 규칙을 검사한다.
  - 근거: §6.7 L795·804-806
- `external_write_authority`
  - 단일 행: host_id, generation, state(`granted/blocked`), credential_fingerprint, blocked_reason, reconciled_at — GitHub(git 저장소를 호스팅하는 서비스) 등 공유 외부 쓰기 권한
  - generation(외부 쓰기 권한의 세대 번호)은 줄어들지 않는다. host가 바뀌면 반드시 올라간다.
  - 이 행은 지우지 않는다. 초기화(§5)에서도 GitHub 연결과 함께 generation·차단 상태를 그대로 둔다.
    - 왜: 초기화로 세대 번호가 처음으로 돌아가면, 옛 PC가 옛 번호로 외부에 쓰는 것을 다시 막을 수 없다.
  - 근거: contracts §3.4-5
- `task_attempts`
  - attempt_key unique, job unique, task, base/head SHA, spec_revision, input_version, kind(`dev/qa/rework/reverify`), agent, status(§3.2), started/ended_at, model_id, effort, grade_adjust(kind·reason), summary, failure, tokens, resumed_from.
  - **Task당 열린 시도 1개**(부분 unique).
  - claim은 열린 시도뿐 아니라 **미해제 `execution_holds`(§2.5-1)**로 Task·충돌 묶음·슬롯을 판정.
  - 근거: §4.6 §6.6
- `attempt_files`
  - 저장소 상대 경로
  - 근거: §8.2
- `attempt_subagents`
  - designated/installed/observed_used, version, def_hash, confirm(`confirmed/partial`)
  - 근거: §6.7-7
- `attempt_observations`
  - cli, version, grade, observed, reserved, state(`ok/unconfirmed`), pgid/cgroup 상태, at
  - grade(관측 등급)의 저장 값은 `ok/partial/unver`, API 값은 `verified/partial/unverified`이며 경계에서 바꾼다(`OBSERVATION_GRADE`).
  - 근거: §6.7
- `verifications`
  - attempt unique, result(`PASS/FAIL/BLOCKED`), **head_sha, spec_revision**, cmd, expected, actual — 추가 전용.
  - 근거 무효화는 `verification_invalidations` 행으로 추가.
  - 근거: §4.7
- `defects`
  - def_key, verification, blocking, resolved_by_verification — **원 행은 불변, 해소는 이벤트 행**
  - 근거: §5.5
- `evidence`
  - task, attempt?, verification?, checklist?, kind, storage_path, sha256, size
  - 근거: §4.7

#### 2.5-1 실행 보유의 단일 정의

**보유(hold)란**: job 하나가 실행되는 동안 차지하는 것들의 기록이다. 두 가지를 따로 센다.

- **물리 슬롯**: PC(개인용 컴퓨터)의 CPU(계산을 하는 처리 장치)·메모리 같은 실행 자리. 프로그램 실행에 쓸 PC 자리다. 실행 전 예약(`reserved`)과 종료 미확인 보유(`unconfirmed`)도 용량에 포함한다.
- **논리 잠금**: 「이 Task(또는 충돌 묶음)는 지금 내가 맡고 있다」는 표시. 개발→검사→QA로 넘어가는 동안 계속 필요하다.

job 하나에 열린 보유 행 하나를 둔다. 닫힌 행은 과거 이력으로 남긴다. 물리 슬롯과 논리 잠금은 두 축이며 **전체 상태는 저장하지 않고 계산**한다.

- 왜 두 축으로 나누나: 검사 사이 잠깐 쉬는 동안 PC 자리는 돌려줘도 되지만, Task 잠금까지 풀면 다른 일이 끼어들어 같은 파일을 건드린다.

| 축 | 값 | 뜻 |
|---|---|---|
| `slot_state` | `none` | 지금 잡은 슬롯 없음(최초·CLI와 ① 사이·종료) |
| | `reserved` → `active` | 용량만 예약 → 프로세스 그룹 등록·실행 |
| | `unconfirmed` | 종료를 확인하지 못함. 같은 host에서는 용량을 계속 차지 |
| `lock_state` | `none` | Task·묶음 잠금이 필요 없는 job |
| | `held` | 잠금 소유 |
| | `handed_over` / `released` | 다음 job에 인계 / 반환(종료값) |
| | `orphaned` | host 변경으로 잠금 효력만 제거, 감사용(종료값) |

**규칙**

- **미해제** = `slot_state ≠ none` 또는 `lock_state = held`.
  - 둘 다 아니면 `closed_at`을 채우며, 닫힌 행은 다시 열지 않는다.
- `reserved`는 프로세스 생성·`/process` 기록 전까지다.
  - 이 구간에서 끊기면 pgid가 없는 채 `unconfirmed`가 되고 contracts §3.4-3의 확인 뒤에만 해제한다.
- 슬롯 전이:
  - `none→reserved→active→none`
  - `reserved→none`
  - `reserved/active→unconfirmed→none`
  - `none`으로 가려면 release_proof 필요.
    - pgid나 cgroup이 기록됐거나 `active`였던 슬롯은 `no_process` 증거로 풀 수 없다.
  - `none→reserved`에는 host_id·boot_id·fence가 모두 있어야 한다.
  - CLI 재기동은 `none→reserved→active`를 다시 밟는다.
- 프로세스 그룹(pgid·cgroup)은 `/process`의 `reserved→active`에서만 기록한다.
  - 같은 그룹으로 `/process`를 다시 보내면(재전송) 받아들인다. 다른 그룹으로 바꾸려 하면 거부한다.
  - 왜: 네트워크가 끊겨 같은 보고를 다시 보내는 것은 정상이지만, 그룹이 바뀌면 다른 프로세스의 보유로 바꿔치기될 수 있다.
- 잠금 전이:
  - `none→held`(claim)
  - `held→handed_over/released/orphaned`
  - `released`는 같은 host에서 `slot_state=none`일 때만, `handed_over`도 이전 job의 `slot_state=none`일 때만 가능.
- host 변경:
  - 이전 host 행은 `lock_state=orphaned`, 남은 슬롯은 `unconfirmed`.
  - 새 host의 용량·잠금 계산에서 제외하고 이전 host 정리 대상으로 남긴다.
  - 외부 쓰기는 contracts §3.4-5.
- 부분 unique(모두 `WHERE lock_state='held'`): `(task)` 그리고 `conflict_group IS NOT NULL`인 `(conflict_group)`.
  - 슬롯 상태는 이 조건에 넣지 않으므로 `unconfirmed`여도 잠금이 남는다.
  - 열린 시도 unique와 별개.
- 용량 합계: 현재 host에서 `slot_state IN (reserved, active, unconfirmed)`인 행의 `slots`(하위 Agent 보유 계산 포함).

**인계와 자기 보유**

1. 인계는 한 트랜잭션이다.
   - 이전 행 `held→handed_over, handed_to_job=B` → B의 보유 행을 `lock_state=held, slot_state=none, lock_from_job=A, host/fence=null`로 생성.
   - 사이에 다른 claim이 끼지 못한다.
   - DB는 트랜잭션이 끝날 때(커밋 직전) 두 행이 서로를 가리키는지 검사한다. epoch·프로젝트·Task·충돌 묶음도 같아야 한다.
     - 왜 끝날 때 검사하나: 두 행을 차례로 쓰는 동안에는 잠깐 한쪽만 있는 순간이 생긴다.
2. **자기 보유 = `hold.job = 요청 job`**이고 epoch가 같은 행.
   - claim은 자기 행의 `held` 잠금을 충돌에서 제외하고, 그 행에 host·fence를 기록하며 `slot_state none→reserved`로 바꾼다(새 행을 만들지 않음).
   - 인계 없는 최초 claim은 새 행을 만든다.
   - 왜: 자기가 넘겨받은 잠금을 「다른 job의 잠금」으로 착각해 스스로 막히는 일을 피한다.
3. `start`·`slots/acquire`·`release`는 자기 행이면서 host·fence가 일치해야 한다(낡은 fence의 release 예외는 contracts §3.2-4).
   - 자기 슬롯은 용량에서 한 번만 세고 타 job 행은 모두 검사한다.
   - `start`는 슬롯을 `reserved`로 두고 `/process`가 `active`로 바꾼다.
4. B가 claim 전에 취소되면 B의 잠금을 `released`로 닫는다. 이전 job A는 인계 뒤 자기 보유로 인정되지 않는다.

### 2.6 Runner · 정책

- `runner_sessions`
  - started_at, ended_at, end_reason, last_heartbeat_at — 종료 1회 외 불변
  - 근거: §8.2
- `runner_hosts`
  - host_id, boot_id, cpu, cores, mem/swap/disk, os, per_session_gb, samples, seen_at(이력)
  - boot_id: host 보고(`POST /runner/host`의 `bootId`)의 현재 부팅 ID. 공백 금지. 이 열이 생기기 전 행은 null이다.
    - 왜: 보유를 풀 때 「PC가 다시 켜졌다」는 증거(`boot_changed`)를 현재 부팅 ID와 대조하려면 저장해 둬야 한다.
  - API의 `diskFreeGB`는 `disk_gb`에 저장한다.
  - 근거: §6.6
- `runner_concurrency_log`
  - limit, running, subagents(관측/보유), heavy, resources, adjust(from/to/reason)
  - 근거: §6.6
- `concurrency_settings`
  - mode(auto/manual), caps, mem_reserve_gb, subagent_budget(dev/qa)
  - 일정 계산이 쓰는 동시 실행 값 (M2-07 재작업 F1):
    - `caps`가 아직 없을 때만 전체 2·Agent별 1로 계산한다. 설정이 있으면 그 값을 쓴다.
    - 현재 한도는 가장 최근 `runner_concurrency_log.limit`(상한 안으로 자름)이다. Runner 보고가 없으면 상한을 현재 한도로 본다.
    - 하위 Agent 비율은 관측 창(`window_days`, 기본 7일) 동안 「하위 Agent 수 합 ÷ 실행 세션 수 합」이다. 관측이 없으면 0이다(P의 0.5는 Mock 값).
    - 왜: 일정은 실제로 돌 수 있는 수만큼만 겹쳐 잡아야 한다. 관측이 있는데 상한만 쓰면 일정이 실제보다 빠르게 나온다.
  - 근거: §6.6 §6.7
- `runner_readiness`
  - key unique, status, detail, fix, at
  - 근거: §7.4
- `agent_usage`
  - agent, remain_pct(0~100), reset_at, tokens_used
  - 근거: §6.2
- `agent_models` / `agent_efforts`
  - `agent_models`: 보고값, rank, allowed(신규=false), is_new
    - rank는 Runner 보고값이 아니다. 서버가 `app_settings.model_settings`의 순서(`rankOrder`)에서 계산해 넣는다(owner 2026-11-26 아이템 8, §6.2).
    - 순서 설정이 바뀌면 rank도 다시 계산한다.
  - `agent_efforts`: **CLI×모델별** 값→공통 1~5 명시 매핑(owner Q-06 승인표, ultra·미확인은 미매핑=사용 안 함)
  - 근거: §7.2
- `exec_policy`
  - on_usage, low_pct(사용량 부족 기준, 기본 20% — owner 2026-11-26), on_rework, esc_notify, floors, live_inject, auto_retry_limit=2, auto_rework_limit=3
  - `live_inject`(실행 중 전달): owner Q-07(2026-11-27 아이템 18)로 이번 범위에서는 켤 수 없다. 화면은 「준비 중」, 서버는 켜는 저장을 거부한다.
  - 기존 `true`는 `false`로 취급한다. 다음 Workflow(기본 실행 흐름) 설정 저장 때 `false`로 정리한다. 왜: 이번 범위는 메시지를 다음 실행 때 전달하는 동작만 제공하기 때문이다.
  - API 이름과의 대응:
    - `esc_notify`는 API의 `notifyAt`이다.
    - `low_pct`가 null이면 API는 도메인 기본값 20을 보낸다(경계 변환 `execPolicyToApi`).
  - 근거: §7.3, owner Q-04
- `subagent_defs`
  - id, version, agent, role, tools, sandbox(프로그램이 건드릴 수 있는 범위를 막아 둔 실행 환경), text, hash, allowed, ref — 버전 불변
  - sandbox 칸은 **표시용 설명**이다. 실제 권한을 보장하지 않는다(M5-06 리뷰).
    - Codex 하위 Agent는 역할 파일에 적은 `sandbox_mode`를 무시하고 부모 세션의 sandbox·승인 정책을 그대로 물려받는다(최신 codex 소스 기준). 그래서 v1 Codex 정의는 `sandbox_mode`를 적지 않고, 검사기가 적힌 것을 거부한다.
    - Codex 정의의 권한 표시는 「부모 세션 권한 상속」으로 시작한다. 「수정 금지」 같은 제한은 지시문 제한이며 「(지시문)」을 붙인다.
    - 읽기 전용을 기술로 보장하려면 Runner가 그 세션을 읽기 전용으로 시작해야 한다. 이것은 정의가 아니라 Runner 실행 정책의 일이다(M8 확인 목록, `packages/db/seed/subagents/REVIEW.md`).
  - 근거: §7.4
- `cli_observation_grades`
  - cli+version+model+options unique, grade, verified_at, notes
  - grade 저장 값과 API 값의 대응은 `attempt_observations`와 같다(`ok`↔`verified`, `partial`↔`partial`, `unver`↔`unverified`).
  - 근거: §6.7

### 2.7 일정 · 보고서 · 알림 · 설정

- `schedule_policy`
  - auto_replan, cp_auto, threshold_days, assume_rate, window_days=7, min_hours=72
  - 기본값 (owner 2026-11-26 아이템 7, 마이그레이션 0019):
    - 가정 가동률 `assume_rate` = 0.6(60%)
    - 재조정 임계값 `threshold_days` = 1(1일)
    - 둘 다 설정에서 바꿀 수 있다.
    - 0019는 기존 DB에서 비어 있는(null) 칸만 채운다. 팀장이 이미 넣은 값은 덮지 않는다.
  - 값이 null일 때 일정 계산(Planning·재조정, `GET /api/schedule`)이 쓰는 유효값:
    - `auto_replan` null은 「끔」으로 읽는다. 재조정은 `pending`으로 기록되고 기준 버전이 생기지 않는다(D-10).
    - `assume_rate` null은 0.6, `threshold_days` null은 1을 쓴다.
    - 왜: G에 확정 근거가 없는 값(`auto_replan`)은 켜진 것으로 추정하지 않는다. owner가 정한 값은 seed와 계산이 같은 값을 쓴다.
  - 근거: §6.4 §10
- `blackout_days`
  - date unique, note
  - 근거: §6.2
- `schedule_baselines` / `baseline_items`
  - `schedule_baselines`: unique(project, v), 예상·범위·적용 가동률
  - `baseline_items`: Task별 시작·종료·lo·hi — 추가 전용
  - 근거: §6.4
- `replans` / `replan_moves`
  - `replans`: rp_key, trigger, actor, baseline_v?, status(`applied/pending/discarded`), before/after
    - `discarded`는 반영하지 않고 닫은 대기 재조정이다.
    - `pending`에서 `applied` 또는 `discarded`로 **한 번만** 확정한다. 확정할 때 바꿀 수 있는 열은 status·baseline_v·after뿐이다.
    - 왜: 재조정은 일정 이력이다. 확정한 뒤에 다시 고치면 「그때 무엇을 반영했나」를 알 수 없다.
  - `replan_moves`: Task별 이동·신규·제외
  - 근거: §6.4
- `reports`
  - kind, from, to, view 기본값, snapshot(jsonb), generated_at, due_at, reason.
  - 정기: unique(project, kind, from, to) 부분 인덱스. **불변**
  - 근거: §4.11 §8.5
- `report_pdfs`
  - report, view, path, sha256 (캐시)
  - 근거: §8.5
- **보고서 상태 이력** (`state_log`·`global_log`·`log_clock`·`commit_log`·`commit_real`, M6-01, 마이그레이션 0028·0029)
  - 기간 지정·정기 보고서가 「기간 끝 시점(T)의 상태」를 되살리려고 남기는 이력이다(owner 2026-11-27 아이템 13, G L375).
  - 보고서가 읽는 모든 표의 행이 바뀔 때마다 행 전체를 남긴다. 프로젝트 행은 `state_log`, 프로젝트가 없는 행(설정·실행 PC·전역 알림)은 `global_log`다.
  - 「T 전」은 문장 실행 시각이 아니라 **커밋**으로 정한다. 한 변경은 아래 둘이 모두 참일 때만 T 시점 상태에 들어간다(`apps/api/src/reports/README.md` §2).
    1. 커밋 시계 값(stamp) < T. 쓰기 트랜잭션은 커밋 직전에 커밋 시계(`log_clock`)를 한 칸 올리고 그 값을 `commit_log`에 남긴다. 시계 값은 「직전 값 + 1µs」와 「지금 시각」 중 큰 값이라 PC 시계가 뒤로 가도 줄지 않는다.
    2. 실제 커밋 시각 < T. 실제 커밋 시각은 PostgreSQL이 `track_commit_timestamp=on`일 때 기록하는 값이고, 정리 단계(`awbs_settle_commits`)가 `commit_real`에 옮겨 적는다. 모르면 「정리가 커밋됨을 처음 본 시각(observed_at)」 < T로 판단한다. 커밋 시계 값으로 채우지 않는다.
    - 왜 둘 다인가: 커밋 시계 값은 제약 트리거를 일찍 실행하면 실제 커밋보다 먼저 매겨질 수 있다. 실제 커밋 시각만 보면 PC 시계가 뒤로 갈 때 결과가 흔들린다. 순서와 결정성은 커밋 시계가, 「정말 T 전에 커밋됐나」는 실제 커밋 시각이 맡는다.
    - 보고서는 먼저 시계를 올린 기준점을 잡고 그 뒤에 읽는다. 그래서 「그때 만든 보고서」와 「나중에 다시 만든 같은 보고서」가 같다.
    - 그래서 `track_commit_timestamp=on`이 꼭 필요하다(§6). 꺼져 있으면 정리 함수가 `55000`으로 거부하고 보고서 생성도 실패한다.
  - 기록은 SECURITY DEFINER 함수만 쓴다. 앱 역할(`awbs_app`)은 읽기만 한다.
  - 이 표들은 Drizzle 스냅샷 밖의 SQL 전용 표다.
  - 되살린 행에도 저장 순번(`record_no`·`run_no`)이 들어 있어 「최신 한 행」을 화면과 같은 기준으로 고른다(§1 「저장 순번」, 0037이 옛 이력의 빈 순번을 채움).
  - 보고서 스냅샷의 프로젝트 이름(`projectName`)과 출처(`projectNameStatus`: `snapshot`·`filled`·`unknown`)는 0030이 옛 보고서에도 채웠다. 확실하지 않으면 `unknown`으로 두고 추측하지 않는다.
  - 근거: §4.11, G L375
- `mail_settings`/`mail_recipients`
  - `mail_settings`: SMTP(비밀값은 secrets)
  - `mail_recipients`: email lower unique, daily/weekly 하나 이상 또는 inactive.
    - 외부 수신자 구분: owner Q-13 A(2026-11-27 아이템 19)로 필요해졌다. 외부 수신자에게는 링크 없이 PDF만 보낸다.
  - `mail_recipients.external`(Q-13 결정 A, 0041): 외부 수신자. 참이면 view='ext' · pdf=true · daily=false여야 한다(검사 `recipient_external`).
    - 왜: 외부 수신자에게는 링크 없이 보고용 + PDF만 보낸다. 일간 보고서는 팀장용만 있다.
  - 근거: §4.11
- `mail_outbox` / `mail_log`
  - `mail_outbox`: delivery_id(논리 발송), epoch, unique(report, recipient, try_no), state(§3.7)
    - 발송마다 보기·사유·제목·첨부 여부도 함께 저장한다(0031). 수신자 설정이 나중에 바뀌어도 「그때 어떤 보기로, 왜 보냈는지」가 남아야 하기 때문이다(G L407).
    - 15분 뒤 자동 재시도는 한 번뿐이고, 했는지를 기록한다.
  - `mail_outbox.external`(Q-13 결정 A, 0041): 외부 수신자에게 간 발송인지(발송 당시 값). 참이면 view='ext' · pdf=true(검사 `mail_outbox_external`)
  - `mail_log`: 수신자 삭제 후에도 주소 보존
  - 근거: §9.6-6
- `notify_settings`/`notify_rules`
  - `notify_settings`: enabled, chat_id, target_name, bot, 테스트 입력 지문
  - `notify_rules`: 이벤트 6종. `serviceDown`은 규칙이 없는 알림이다(§3.7).
  - 근거: §4.14
- `notify_events`
  - dedup_key, resolved_at, dup_count. **열린 키 1개**(부분 unique where resolved_at is null)
  - 열린 키 1개는 프로젝트 범위와 전역(project_id null)을 따로 센다.
  - 근거: §8.7
- `notify_outbox` / `notify_log`
  - `notify_outbox`: delivery_id, epoch, 대기·시도·next_at, event unique(상태와 관계없이 이벤트 하나에 outbox 하나)
  - `notify_log`: 업무·테스트, 상태, 오류 요약
  - 근거: §8.7
- `alerts`
  - 대시보드 현재 상태 알림: key unique(열림), severity, target
  - 열린 알림의 unique는 프로젝트 알림과 전역 알림(project_id null)을 따로 센다.
  - 근거: §4.1 §4.14 L522
- `app_settings`
  - app_url, heartbeat 주기·누락 횟수, 분할 기준, 작업 흐름 기본값, 시간대, model_settings
  - `model_settings`(jsonb): 모델 순서·Codex 계열 순서·Claude 모델 목록이다(owner 2026-11-26 아이템 8). 모양과 초기값은 §6.2.
    - API `GET/PUT /api/settings/models`의 `rankOrder`·`codexFamilyOrder`·`claudeModels`와 이름이 같다.
    - 세 항목이 모두 있어야 한다(CHECK `app_model_settings_shape`).
  - 근거: §4.9
- `github_settings`
  - mode, status, scopes, warning, expires_at, account
  - `scopes`(jsonb, null 가능): 권한별 확인 상태 `{contents,pulls,statuses,metadata}`. 값은 `verified`·`unverified`·`missing`이다(조정자 결정 2026-11-26).
    - null은 「확인 안 함」이다. 네 권한이 정확히 있어야 하고 다른 키는 없어야 한다(CHECK `github_scopes_shape`).
    - 마이그레이션 0016 전에는 `text[]`였다. 옛 값의 뜻을 알 수 없어 추정하지 않고 null로 바꿨다. 다음 연결 확인 보고가 채운다.
  - `warning`(text, null 가능): 미확인 권한처럼 팀장에게 알릴 문구. 공백만 있는 값은 거부한다.
  - Runner 봉인용 공개키 등록(`POST /runner/github/key`)은 DB에 저장하지 않는다. 서버 메모리에만 둔다(contracts §3.1).
  - 근거: §8.4

### 2.8 설계 · CI · 이력

- `tech_constraints`
  - 이름, level(must/cond/ban), condition — 등록 시
  - 근거: §4.2
- `tech_decisions` / `tech_decision_events`
  - td_key, authority(lead/agent/free), status(fixed/approved/pending/rejected/noted/change)
  - 근거: §4.12
- `design_snapshots`
  - commit, ref(main/브랜치), parse 상태 — 커밋 기준 캐시
  - 근거: §9.6-1-1
- `design_files` / `design_items` / `design_edges` / `design_ownership`
  - `design_files`: 파일 파싱 결과(마지막 성공 유지)
  - `design_items`: unique(snapshot, item_key)
  - `design_edges` / `design_ownership`: API×테이블·구성도
  - 근거: §4.12
- `design_drifts` / `design_versions`
  - item_key, kind, compat(호환/깨짐/`대조 안 함`), status, resolution
  - `design_drifts`에는 `record_no`가 있다(0037). 같은 항목의 「최신 불일치」를 이 순번으로 고른다.
  - drift는 계약 문서와 실제 코드가 서로 어긋난 상태다.
  - compat 저장 값은 화면 문구(호환/깨짐/대조 안 함)이고, API 값은 `compatible/breaking/unchecked`다. 경계에서 바꾼다(`DRIFT_COMPAT`).
  - 근거: §4.12 §9.6-1-4
- `ci_runs` / `ci_steps`
  - run_key, stage, **base_sha, head_sha, merge_sha, tree_sha, pipeline_sha**(단계별 해당 값), ref, pr, task?, attempt?, trigger, status, fail_step, log_excerpt, artifact_path, url, job?, fence?, artifacts
  - M7에서 더한 열(마이그레이션 0026, contracts §3.6):
    - `run_no`: 실행 저장 순번. 「Task의 최신 ① 결과」와 목록 커서가 이 값을 쓴다(§1 「저장 순번」).
    - `reporter`: 실행을 시작한 Runner. job이 없는 야간 점검도 시작한 Runner만 갱신하게 하려는 것이다.
    - `fail_scope`: 실패한 ①의 원인 쪽(`baseline`·`task`, CHECK `ci_fail_scope`). 기준 실패는 Task 실패로 세지 않는다.
    - `cause_candidates`: 야간 점검 실패의 원인 후보 커밋 목록(jsonb 배열, 기본 `[]`).
    - `note`, `e2e`, `github_status`, `finished_at`: 보고 메모, 전체 E2E 집계, GitHub 상태 게시 결과, 끝난 시각.
  - `ci_steps.duration_ms`: 단계별 소요 시간(ms, 0 이상). `ci_steps`에도 `record_no`가 있다.
  - stage는 1~4 숫자로 저장하고 API 값과 task=1, int=2, night=3, deploy=4로 바꾼다(`CI_STAGE`).
  - pipeline_sha·trigger는 NOT NULL이다. 그래서 API 시작 요청에서도 필수다(contracts §2.3).
  - job·fence: 실행을 시작한 job과 그 fence.
    - job이 없는 실행은 야간 점검(stage 3)뿐이다(제약 이름 `ci_job_owner`).
    - job과 fence는 함께 있거나 함께 없다.
    - 왜: Runner의 다음 보고(갱신)를 시작한 job·fence와 대조해야 낡은 보고를 거절할 수 있다(contracts §3.2-4).
  - artifacts: 산출물 경로 목록(jsonb 배열).
  - 시작 시각은 별도 열 없이 created_at을 쓴다.
  - 이전 버전에서 저장된 행(마이그레이션 0013 전):
    - 시작한 job은 알 수 없으므로 지어내지 않는다. 그래서 job이 빈 1·2·4단계 실행이 남을 수 있다.
    - 「야간 점검만 job 없음」 규칙은 새 행과 규칙을 지키던 행에 적용한다.
    - 이미 규칙을 어긴 이전 행은 단계를 바꾸지 않고 job도 비어 있는 갱신(결과·산출물·URL 저장 등)만 허용한다.
    - job이 있던 1·2·4단계 실행에서 job을 지우는 것은 거부한다.
    - 이 규칙도 CHECK가 아니라 같은 이름의 트리거로 검사한다(0014). 오류 코드는 23514다.
  - 근거: §4.13
- `merge_queue`
  - pr, task unique(열림), position, status, qa_head_sha(H), synced_head_sha(H'), base_sha(A), verification, ci_run, tested_tree_sha, **actual_merge_sha·actual_tree_sha**
  - M7에서 더한 열(0026):
    - `head_sync`(jsonb): H→H′ 보존 증거(사슬 포함). 자동 완료와 팀장 완료 버튼이 같은 근거를 쓰게 한다(contracts §4.1 코드 근거 고정 3-2).
    - `merge_parents`(jsonb): 실제 PR 병합 커밋의 부모 2개.
    - `queue_no`: 대기열 저장 순번. `merged_at`: 병합 시각.
- `ci_merge_facts`
  - (project, merge_sha) 기본 키, tree_sha, parents — 병합 SHA마다 **첫 기록**을 남긴다(0026).
  - 같은 병합 SHA의 tree·부모는 바꿀 수 없다. 다른 부모로 다시 보고하면 409 `MERGE_MISMATCH`다(contracts §3.6-5).
  - 왜: 첫 기록을 고칠 수 있으면, 대조에 실패한 병합을 나중 보고로 「맞는 것」처럼 덮을 수 있다.
- `projects.pipeline_observations`(jsonb, 기본 `{}`)
  - main 커밋(A)별 pipeline 정의의 첫 관측이다(M7-04 결정 5). ② 실행의 `pipeline_sha`와 대조한다. 성공한 관측만 남긴다.
  - A·H·H'의 뜻은 [contracts §4.1](contracts.md#41-시도-1회) 「코드 근거 고정」 3번에 있다.
  - 근거: §4.13
- `flaky_tests`
  - test_key, rate, quarantined, task, last_failed_at(0026)
  - `quarantined`가 참인 테스트 목록이 Runner 정책 `ci.quarantined[]`로 나간다(contracts §3.1).
  - 근거: §4.13
- `ci_settings`
  - night_at, retry=1, deploy_url, settings_version(0026)
  - `deploy_url`은 이 PC(loopback) 주소만 대상이 된다(owner Q-15 A, M7-03 결정 6).
  - 근거: §4.13
- `messages`
  - msg_key, task, attempt?, dir, type, to_agent, body, **delivery**, **pending_next**, **work_state**, fail_reason, read_at, draft — 세 상태 별도(§9.4-1)
  - 왜 세 상태를 따로 두나: 「전달됐다」「다음 실행에 넣을 예정이다」「Agent가 일을 끝냈다」는 서로 다른 사실이다.
  - 근거: §4.10
- `task_history`
  - 추가 전용: at, actor, task?, kind, text, before, after, ref
  - 근거: §4.9 §9.1-3
- `idempotency_keys`
  - unique(project_id, epoch, principal, key) NULLS NOT DISTINCT, request_hash, response, epoch
  - NULLS NOT DISTINCT는 「project_id가 null인 행끼리도 같은 값으로 보고 중복을 막는다」는 뜻이다.
    - 왜: 보통 unique는 null끼리를 서로 다르다고 봐서, 프로젝트 등록 전(null)의 같은 키가 두 번 저장될 수 있다.
  - 근거: §9.1-6
- `change_events`
  - seq bigserial(자동 번호를 발급하는 큰 정수 열. 실패·취소로 중간 번호가 비기도 한다), topic, ref, at — 화면 커서. 7일 보존 [결정]
  - 근거: 아키텍처 2.1

## 3. 상태 전이

- 전이표는 `packages/shared`에 표로 두고 서버가 강제한다(§9.1-5·7).
- 표에 없는 전이는 409 `INVALID_TRANSITION`.
- §3.1은 G [미결 3]에 대해 **owner가 승인한 표**다(Q-05, 2026-11-25). 바꾸려면 owner 승인이 필요하다.
- 왜 표로 두나: 상태가 바뀌는 규칙을 한곳에 모아 두면, 화면·서버·테스트가 같은 표를 보고 판단할 수 있다.

### 3.1 Task 대표 상태

그림으로 보기: [Task 상태 흐름](diagrams/task-states.svg) (open-questions §0.1의 승인된 Q-05 표를 그린 것)

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
| `qa`,`verifying` | `gate` / `rework` / `paused` / `failed` | 아래 목록 참고 |
| `qa` / `verifying` | 같은 상태 | BLOCKED 뒤 원인 해결 → **새 qa/reverify 시도·새 검증**. 기존 검증은 불변 |
| `rework` | `running` | rework 시도 |
| `gate` | `verifying` | 검증 뒤 head SHA·명세 revision이 바뀜 → 근거 무효, 재검증 |
| `gate` | `done` | 아래 목록 참고 |
| `gate` | `rework` | ② 통합 실패·병합 충돌 |
| `planning`,`approval`,`ready` | `cancelled` | CP remove, 실행 이력 없음(D-16) |

긴 칸을 풀어 쓴 것:

- `qa`,`verifying` → `gate` / `rework` / `paused` / `failed`
  - 조건: PASS / FAIL / 중단 / QA 프로세스 자체 실패.
  - **BLOCKED는 상태 유지**(시도는 completed, verif=blocked, P `registerQa`).
  - BLOCKED는 「검증 환경 문제 등으로 판정을 못 했다」는 결과다. 코드 잘못이 아니므로 재작업으로 보내지 않는다.
- `gate` → `done`
  - 조건: Gate 5조건 + 현재 head에 유효한 QA + ② 통과 + 검사한 병합본과 실제 병합 일치를 서버가 같은 트랜잭션에서 판정(§5.5, §4.13).
  - 「필요한 승인」은 **착수 승인**(`planning_approved_at`)이며 별도 완료 승인 없음(owner Q-02).

**종료 상태와 선행 충족**

- `done`·`cancelled`는 종료.
- 차단은 저장하지 않는 계산값.
- SS 선행은 `planning/approval/ready/cancelled`가 아니면 충족, FS는 `done`이면 충족(P `depMet` L3677).
- **시작 전 취소된 선행의 SS 관계는 취소 반영 트랜잭션에서 제거**하고 제거 이력·후속 차단 재계산을 남긴다(owner 2026-11-25, D-27).
  - P의 SS 판정과 달리 `cancelled`는 시작으로 세지 않는다.
  - 다른 선행이 미충족이면 후속은 계속 차단된다.
  - FS도 P `simulate`처럼 관계를 제거한다.
  - 예: A가 B의 SS 선행인데 A가 시작 전에 취소되면, A→B 관계를 지운다. B에게 다른 미충족 선행 C가 있으면 B는 여전히 차단이다.

#### 시도 종류별 claim 허용

claim은 Runner가 「이 일을 제가 하겠습니다」 하고 job을 예약하는 요청이다. Task 상태에 따라 예약할 수 있는 시도 종류가 정해져 있다.

공통: 열린 시도 없음, Task·충돌 묶음에 **다른 job의** `held` 잠금 없음(자기 보유·타 PC 예외는 §2.5-1), 정리 대기 없음.

| Task 상태 | 허용 종류 | 추가 조건 |
|---|---|---|
| `ready` | dev | 선행 충족 + **팀장 시작 버튼** |
| `rework` | rework | 최근 검증 FAIL 또는 통합 실패. 자동 3회까지, 초과는 팀장 버튼 |
| `qa` | qa | ① 통과, 최초 또는 직전 qa가 BLOCKED |
| `verifying` | reverify | rework의 ① 통과, 직전 reverify가 BLOCKED, 또는 근거 무효화 |
| `paused` | 중단된 종류 | 아래 목록 참고 |
| `failed` | 실패한 종류 | 직전 시도 failed. 같은 종류 연속 실패에 자동 재시도 2회(최초 포함 총 3회), 이후 팀장 버튼 |
| 그 외 | 없음 | 409 |

- `paused`의 추가 조건:
  - 직전 시도 interrupted, 같은 등급.
  - 모델이 허용 해제됐으면 재판단 완료 후 새 등급 + 이력(D-29).
  - 재개는 팀장 버튼(P).

### 3.2 시도와 시작 전 실패

- 시도 상태: `running → completed | failed | interrupted` (화면: 실행 중/완료/실패/중단).
- 종료 상태는 불변.
- ① 실패의 분류(M5-05 조정자 결정 3, contracts §3.5):
  - Task 코드 때문에 ①이 실패하면 `failed`이고 재작업으로 간다.
  - 기준(main) 실패(`failScope=baseline`)나 Runner·환경 문제로 결과를 모으지 못하면 `interrupted`이고 같은 시도를 다시 한다. 재작업 횟수에 세지 않는다.
- **claim은 job 예약만 하고 시도를 만들지 않는다.**
- 시작 전 자원 부족 반환(`POST /api/runner/jobs/:id/return`)은 job을 `leased → queued`로 돌린다. 시도 행은 만들지 않는다.
- 반환 때 `attempts`는 1 줄인다. `lease_owner`와 `lease_until`은 비운다. fence(낡은 Runner의 보고를 막는 번호표)는 그대로 둔다.
- 물리 슬롯은 `none`으로 돌리고 `no_process` 증거를 남긴다. 논리 잠금은 `held`로 유지한다. `runner_job_events`에는 `returned`를 남긴다.
- 왜: 실행 전 자원 부족은 실패가 아니다. 잠금을 유지해야 같은 Task나 충돌 묶음의 다른 작업이 끼어들지 않는다.
- `runner_jobs.resource_returns`는 같은 job의 연속 반환 횟수다. 4에서 더 늘리지 않는다. `resource_retry_at`은 다음 claim 가능 시각이다.
- 1·2·3번째 반환은 1·2·4초를 기다린다. 4번째부터는 자원 부족 경보와 함께 5분 보류한다. 실제 시작하면 횟수와 대기 시각을 지우고 경보를 해소한다.
- 왜: 재시작 후에도 대기와 경보를 유지하고, 다른 실행 가능한 job이 진행할 시간을 줘야 한다.
- job이 `done`·`failed`·`cancelled`로 끝나면 자원 부족 경보를 해소한다. 왜: 끝난 job의 대기 경보를 계속 남기면 안 된다.
- 하위 Agent 설치까지 성공한 뒤 `jobs/:id/start`가 시도를 만들고 Task를 전이한다.
  - 왜: 설치에 실패했을 때 「시도했다가 실패한 것」으로 기록되면 재시도 횟수와 이력이 부풀려진다.

**설치 실패**(§7.4-4)

- 시도 행 없음, Task 상태 불변.
- job `failed(SUBAGENT_INSTALL_FAILED)`.
- `runner_job_events`와 이력에 시작 전 실패를 추가.
- 실행한 프로세스가 없으면 `no_process`, 설치용 프로세스가 있었으면 그룹 empty 확인 후 보유 해제.
- 「다시 시도」는 새 job.

### 3.3 메시지 전달

- `Draft → Queued → Sent → Acknowledged`
- `Draft/Queued → Cancelled`
- `Queued/Sent → Failed → Queued(재전송)`
- `pending_next`는 별도 플래그.
- `Acknowledged`는 작업 완료가 아니다. (Agent가 메시지를 받았다는 뜻일 뿐이다.)
- **실패한 시도에서 받은 지시** (M5-05 조정자 결정 4)
  - 실패한 시도에서 ack된 팀장 메시지는 다음 시도에도 전달한다. 지시는 시도가 아니라 Task에 대한 것이기 때문이다.
  - 다음 시도의 첫 입력에 「이전 시도에서 받은 지시」로 묶어 넣고, 그 시도에서 다시 ack한다.
  - 성공한 시도에서 ack된 메시지만 끝난 것으로 본다.
  - 다시 전달한 지시에는 업무 응답을 다시 보내지 않는다. 한 지시에 응답은 하나다(M5·M7 통합).
  - 응답 기록과 「응답함」 표시 사이에 Runner가 죽으면 응답이 한 번 더 갈 수 있다. 응답을 잃는 것보다 낫다고 보고 이 순서로 둔다.

### 3.4 프로젝트/초기화

- `none → boot(analyzing → tech_wait → drafting → approval_wait) → active`.
- 어느 상태에서나 초기화 → `none` + epoch+1 + 정리 `pending`.
- 정리 완료 전 bootstrap job claim 금지(§4.2 L261).

### 3.5 CI · 병합 대기열

- CI: `queued → run → pass | fail | skip`.
- 대기열: `waiting_verify → queued → checking → merged | failed | removed`.
- `removed` 뒤 다시 대기열에 넣을 때는 열린 행을 닫고 새로 여는 일을 한 트랜잭션에서 한다(M7-04 결정 2). 열린 행이 겹쳐 500이 나던 문제를 막는다.
- 병합 대조 실패는 `merged`가 아니라 보류다. 실제 병합 SHA와 경고는 먼저 저장한다(contracts §3.6-6).
- 병합 보고의 `mergeCommits`는 `{commit, parents}` 목록이다. 자식 커밋을 부모보다 먼저 적는다. 현재 main과 그 조상은 제외한다.
- 서버는 목록이 실제 병합의 두 번째 부모에서 이어지는지 확인한다. 첫 번째 부모(main), 중복, 순환, 끊긴 커밋은 거부한다.
- 검증한 목록은 첫 병합 사실 `ci_merge_facts.commit_parents`에 저장한다. 이전 병합 기록은 이 값이 없을 수 있다.
- `causeCandidates`의 커밋은 병합 SHA(커밋 식별값), PR 부모, QA head, 보존된 동기화 사슬, 저장한 중간 커밋에서 Task를 찾는다. 연결되는 Task가 정확히 하나일 때만 `taskKey`를 준다.
- 왜: Runner가 원인 Task를 직접 지정하면 다른 Task가 잘못 지목될 수 있다. 서버 병합 기록에 있는 근거만 사용한다. 옛 기록에 없는 중간 커밋은 추측하지 않고 `null`로 둔다.
- 형식은 맞지만 부모 사슬이 잘못된 `mergeCommits`는 버리고 경고를 남긴다. 첫 병합 사실은 저장한다. 이후 다른 목록을 받아도 첫 목록을 덮어쓰지 않는다.
- 왜: 중간 커밋 근거는 병합 사실의 보조 자료다. 보조 자료가 틀렸다고 실제 병합을 지우면 안 된다.

원인 연결에는 다음 한계가 있다.

- 옛 병합 기록에는 중간 커밋이 없을 수 있다. 이를 채우는 보충 도구는 없다.
- B가 A의 브랜치 위에서 만들어지고 B가 먼저 병합되면 A의 커밋도 B에 연결될 수 있다. 연결은 그 커밋을 main에 들여온 병합 Task를 뜻한다. 커밋을 처음 만든 Task와는 다를 수 있다.
- 같은 커밋이 여러 Task의 근거에 있으면 `taskKey`는 `null`이다.
- 조회는 후보마다 저장한 부모 목록을 펼친다. 이 목록에는 검색용 색인이 없다. 기록이 많아져 조회가 느려지면 커밋별 연결 원장과 색인을 검토한다.

왜: 화면의 Task 링크가 뜻하는 범위와, 근거가 부족해 연결하지 못하는 경우를 구분해야 한다.

### 3.6 Change Proposal

- `draft → review → approved → applied`
- `review → changes | rejected`
- 자동 정책 `review → applied | held`
- `held → review`
- 반영은 트랜잭션 안에서 재시뮬레이션하고 문제가 있으면 `held`(§9.1-4).
  - 왜 다시 시뮬레이션하나: 승인한 뒤 반영하기 전 사이에 다른 Task가 바뀌었을 수 있다.

### 3.7 알림

- event: `open → resolved`.
- outbox(메일·Telegram 공통): `queued → sending → accepted | retry_wait | failed | unknown`, `retry_wait → sending`.
  - 용어 풀이: Telegram = 메신저. 알림을 봇으로 보낸다.
- 화면에는 G의 4상태만 쓰고 unknown은 「실패 — 수락 여부 불명」으로 표시(§4.14 L558).
- 정책은 contracts §4.4.
- 규칙이 꺼진 동안에는 event/outbox를 만들지 않는다(§4.14 L524).
- **알림 한 건 만들기는 한 곳에서** (M6 통합, 마이그레이션 0036)
  - 모든 Telegram 알림은 공통 함수 `awbs_notify_emit()` 하나로 알림 기록(`notify_events`)과 발송 대기열(`notify_outbox`)을 같은 트랜잭션에서 만든다.
  - 하는 일: 열린 같은 키가 있으면 중복 수만 센다 → 연결이나 규칙이 꺼져 있으면 아무것도 안 한다 → 기록과 대기열을 함께 넣는다.
  - 그 함수 안에서 오류가 나도 그 일만 되돌린다. 업무 저장(CI 보고·Task 상태)은 계속된다(G L1076).
  - Task·설정·승인 상태 변화는 DB 트리거가 이 함수를 부른다. CI 결과 알림은 M7 CI 코드(`emitNotify()`)가 부른다.
    - 왜 CI는 코드인가: CI의 「최신 결과」 판단과 기준 실패 묶음은 CI 코드만 안다. 트리거로 옮기면 같은 규칙을 두 곳에서 지켜야 한다.
- **`serviceDown`(서비스 없음)** (M7-03 결정 11·14)
  - ④ 배포 확인과 자동 복구까지 실패해 서비스가 없을 때 보내는 높은 우선순위 알림이다. G의 6종에는 없다.
  - 알림 규칙과 무관하게, 전체 알림이 켜져 있으면 보낸다. 메시지 첫 줄은 「[Agent WBS] 서비스 없음」이다.
  - 다음 배포 확인이 통과하면 열린 경보와 알림 키를 닫는다.
- **재시도 한도 알림의 중복 키**: `fail|retry|<시도 묶음 id>`다(0036). 같은 경보의 반복은 중복으로 세고, 팀장이 다시 실행한 뒤 다시 한도를 넘으면 새 알림이다.

## 4. DB가 보장하는 것 / Service가 보장하는 것

어떤 규칙은 DB 제약으로 막고, 어떤 규칙은 서버 코드(Service)가 트랜잭션 안에서 검사한다.

- 왜 나누나: 한 행만 보면 알 수 있는 규칙은 DB가 가장 확실하게 막는다. 여러 행을 보고 계산해야 하는 규칙은 코드가 해야 한다.

**DB가 보장**

- 자기 참조·중복 의존성
- 열린 시도 1개
- 단일 프로젝트
- 열린 알림 키 1개
- 정기 보고서 중복
- 멱등 키
- lo≤est≤hi
- 추가 전용

**Service(트랜잭션)가 보장**

- 순환(DFS + 프로젝트 advisory lock으로 동시 추가 직렬화)
  - 용어 풀이: DFS = 관계를 끝까지 따라가 보는 깊이 우선 탐색; advisory lock = 앱이 정한 이름으로 거는 DB 잠금; 직렬화 = 동시에 오는 일을 한 번에 하나씩 차례로 처리.
  - 풀어 쓰면: 선행 관계를 따라가 순환을 찾는다(DFS). 동시에 관계를 추가할 때는 프로젝트 잠금으로 한 건씩 차례로 검사한다.
- 차단
- Gate
- CP 재시뮬레이션
- 충돌 묶음
- 슬롯
- 완료 Task 보존
- 이력·알림·change_events 동시 기록

## 5. 초기화

초기화는 프로젝트 데이터를 지우고 처음 상태로 되돌리는 작업이다. 순서는 다음과 같다.

1. `system_state` 행 `FOR UPDATE` → 프로젝트 행 잠금 + `confirmName` 일치(§5.1).
2. 해당 epoch 디렉토리 전체를 `file_delete_queue`에 기록, 정리 명령 payload(저장소·기준 커밋·브랜치)를 `runner_commands`에 기록. 기준 커밋이 없으면 저장소 정리는 명령에서 제외(§9.5-2).
   - 정리 명령 payload에는 외부 쓰기 권한의 generation과, 모든 기록 출처에 남은 Agent PR·브랜치도 담는다.
   - payload의 정확한 필드와 공용 고정 예시는 contracts §3.2 「정리 명령 `reset-cleanup`의 payload」에 있다.
   - 왜: 프로젝트 데이터를 지운 뒤에는 어떤 PR·브랜치를 시스템이 만들었는지 다시 알 수 없다.
3. 프로젝트 데이터 삭제. `keepSettings=false`면 설정·환경·Runner 가동 기록·메일/Telegram 설정도 삭제. **GitHub 연결은 항상 유지**(§4.2 L258), 전송 이력은 항상 삭제.
   - GitHub 연결과 함께 `external_write_authority`의 generation·차단 상태도 항상 유지한다(§2.5).
   - `keepSettings=false`여도 빈 설정으로 두지 않는다. 사용자 설정을 지우고 승인된 `system` 기본값을 같은 트랜잭션에서 다시 넣는다(§6).
     - `agent_efforts`와 검토를 마친 하위 Agent 정의는 보존하고, demo 하위 Agent 정의만 지운다.
     - 다시 넣는 일정 정책은 `cp_auto=true`이고, `auto_replan`은 G에 확정 근거가 없어 null이다.
     - 가정 가동률은 0.6, 재조정 임계값은 1일로 다시 넣는다(owner 2026-11-26 아이템 7, §2.7).
     - 왜: 설정 표가 비면 서버가 기본값 없이 판단해야 한다. 승인된 기본값으로 돌아가는 것이 「처음 상태」다.
4. epoch+1, `reset_log` 추가. 1~4는 한 트랜잭션(§9.5-1).
   - 왜 한 트랜잭션인가: 중간에 실패하면 반쯤 지워진 상태가 남지 않고 전부 원래대로 돌아간다.
5. 커밋 후 worker가 파일 삭제, Runner가 정리 실행. 실패는 재시도. 보유 중인 실행 목록(pgid·cgroup·host·boot)은 정리 명령 payload로 옮겨, 그룹 종료가 확인되어야 정리 완료로 본다.

**정리 완료 기록**

- 앱이 감사 표를 직접 고치지 않는다. `complete_cleanup()` 함수가 명령(`runner_commands`)·`reset_log`·`system_state`를 한 번에 갱신한다.
- Runner가 보내는 정리 결과의 `holds[]`가 `complete_cleanup()`의 증거다(contracts §3.2).
  - 성공(done)이면 payload의 모든 보유에 대해, 기록된 job·host·boot와 맞는 증거가 있어야 한다.
  - pgid나 cgroup이 기록된 보유(또는 `active`였던 보유)는 `no_process`로 완료하지 못한다.
  - 증거가 맞지 않으면 DB가 오류 코드 AW002로 거부하고 정리는 완료되지 않는다.
- 왜: 「정리했다」는 말만 믿고 완료하면, 아직 살아 있는 옛 Agent 프로세스가 새 프로젝트의 파일을 건드릴 수 있다.

### 5.1 epoch 원자성

epoch가 바뀌는 순간(초기화)과 다른 쓰기가 겹쳐도 옛 프로젝트 데이터가 새 프로젝트에 섞이지 않게 하는 규칙이다.

- **모든** 변경 트랜잭션(팀장·Runner·worker, 환경 행 포함)은 첫 문장으로 `system_state`를 `FOR SHARE`로 잠그고 epoch를 다시 확인한다.
  - 초기화는 이 규칙에서 빠진다. 초기화는 처음부터 `FOR UPDATE`를 잡는다.
    - 왜: `FOR SHARE`를 잡았다가 `FOR UPDATE`로 올리면, 같은 일을 하는 두 트랜잭션이 서로를 기다리는 교착이 생길 수 있다.
  - DB의 epoch 확인이 실패하면 오류 코드 AW001이 난다. 서비스는 이를 낡은 epoch 오류(409 `EPOCH_MISMATCH`)로 바꾼다.
  - middleware(모든 요청이 처리 전에 거치는 공통 코드) 검사만으로 쓰지 않는다.
  - 왜: middleware에서 확인한 뒤 실제로 쓰기 전 사이에 초기화가 끼어들 수 있다.
- 잠금 순서: `system_state → projects → tasks(id순) → jobs/holds → 그 외`. 역순 금지.
  - 왜: 모두 같은 순서로 잠가야 서로 상대 잠금을 기다리는 교착(deadlock)이 생기지 않는다.
  - 그래도 교착이 나면 DB가 오류 코드 40P01로 한쪽을 취소한다. 서비스는 횟수를 정해 두고 다시 시도한다.
- worker 작업은 생성 시 epoch를 갖는다. 시작과 결과 반영 때마다 잠금 안에서 epoch를 재확인하고, 낡으면 결과를 버린다.
- 파일은 `<epoch>/` 아래에 쓴다.
  - 삭제 작업은 그 epoch의 worker 임대가 끝나거나 만료된 뒤 실행한다.
  - 만료된 worker가 뒤늦게 쓴 파일은 낡은 epoch 디렉토리 재검사로 지운다.
- 발송은 `sending` 전이를 잠금 안에서 확정한 뒤 잠금 밖에서 수행한다.
  - 초기화는 `queued/retry_wait`를 취소한다.
  - **이미 외부로 전송을 시작한 요청은 회수할 수 없으므로** 이력 삭제와 별개로 확인 창에 알린다.

`keepSettings`와 무관하게 삭제: 발송·전송 이력, 보고서, 기준 일정, Task 관련 전부.

## 6. 마이그레이션 · Seed

마이그레이션은 DB 구조를 바꾸는 SQL 파일이고, seed는 빈 DB에 처음 넣는 기본 데이터다.

- Drizzle schema(데이터 모양(필드·타입·제약)의 정의)가 개발 원본, `drizzle-kit generate` SQL을 검토 후 커밋.
  - 트리거·권한·부분 인덱스는 custom SQL migration으로 둔다.
  - 적용된 파일은 수정 금지. (이미 적용된 DB와 파일 내용이 달라지기 때문이다.)
- 이름은 시각 기반(§9.6-2-4 권장).
  - 병렬 작업 충돌을 피하려고 **schema 변경은 M1 이후 DB 담당 한 작업씩** 병합한다.
- 검증: 빈 DB up, 직전 버전 DB up, schema drift 검사.
  - P TASK-0004의 down SQL은 Mock Task 요구이므로 채택하지 않는다.
  - 운영 되돌림은 백업 복원 + 앞으로 고치는 migration을 쓴다 [결정].
- 부트 시 자동 migrate 금지. `db:migrate` 명령으로만 실행.
  - 왜: 서버가 켜질 때마다 DB 구조가 몰래 바뀌면 사고를 알아채기 어렵다.
- Seed 두 가지:
  - `system`: G가 확정한 기본 정책·분할 기준, owner 확정 Q-03 값·Q-04(자동 재시도 2·재작업 3)·Q-06 매핑, 모델 순서·Claude 모델 목록(owner 2026-11-26 아이템 8, §6.2), 검토를 마친 하위 Agent v1 — M5-06
  - `demo`: P `MOCK` 12 Task·`SUB_MOCK`·Q 미승인 잠정값 — **테스트·화면 검증 전용**, 운영 DB에서 실행 거부
- 추가 전용 보장 테스트: 앱 역할로 UPDATE/DELETE가 거부되는지 확인.
- 마이그레이션 0013 전에 저장된 행의 처리는 §2.4 `change_proposals`와 §2.8 `ci_runs`에 있다. 이미 적용된 0000~0012는 고치지 않고 0013·0014를 추가했다.
- 0016(계약 보완 2026-11-26)은 `github_settings.scopes`를 3상태 jsonb로 바꾸고 `warning`을 더했다. `app_settings.model_settings`를 더하고 `seed_system()`이 초기값을 넣게 했다.
  - 0015는 M2 작업(`platform_epoch_lock`)의 마이그레이션이다. 계약 보완 브랜치는 M2-01(6d07221)을 먼저 합쳐, 어느 DB에서나 0015 다음에 0016이 실행되게 했다.
    - 왜: 마이그레이션 도구는 마지막으로 적용한 항목의 시각보다 늦은 항목만 실행한다. 0016을 먼저 적용한 DB에 0015를 나중에 더하면 0015가 건너뛰어진다.
    - 0015는 표 구조를 바꾸지 않는 SQL 전용 파일이라 snapshot(이전 스냅샷 ID로 이어지는 구조 기록)이 없다. 그래서 0016 snapshot은 0014 snapshot에 이어진다.
  - 0016의 CHECK는 계약과 같은 조건을 검사한다. 권한 하나가 JSON null인 값, 목록 자리에 숫자·boolean·null이 든 값은 거부한다(검사 전체가 참일 때만 통과, `awbs_valid_id_list()`).
- 0019(M2-08, 2026-11-26)는 일정 정책 기본값(가정 가동률 0.6, 재조정 임계값 1일, owner 아이템 7)을 `seed_system()`에 넣고, 기존 DB의 빈 칸만 채운다(§2.7).
- **0020~0037**(M2·M3 후속, M5·M7 통합, M6 통합, 2026-11-26~27)
  - 0020~0025: 실행 근거, 프로젝트·설정 후속, Evidence 참조, 설정 버전 열.
  - 0026 CI 보고(§2.8 `ci_runs`·`merge_queue`·`ci_merge_facts`, §1 저장 순번), 0027 Planning 이벤트 저장 순번(M5·M7 통합).
  - 0028~0035 M6(보고서 상태 이력, 보고서 이름, 메일 대기열, Telegram 전이 알림, 설계 원장). M6 통합에서 main 다음 순번으로 다시 매겼다.
  - 0036 알림 공통 함수(§3.7), 0037 저장 순번 보충(M6 자체 표 3개와 옛 이력의 빈 순번, §1).
- **병렬 브랜치의 마이그레이션 번호** (M7-04 조정자 결정 3, M6-05 결정 4)
  - 작업 브랜치는 배정받은 번호로 만들고, **병합 직전에 마지막 순번으로 다시 매긴다**. 파일 이름(tag)·snapshot 파일 이름·`prevId` 연결도 함께 맞춘다.
  - journal의 `when`은 번호 규칙 `1795740000000 + 번호`를 따른다. 예: `0037`이면 `1795740000037`. 그래서 journal의 모든 값보다 크다.
  - 왜: Drizzle(마이그레이션 도구)은 DB에 마지막으로 기록된 시각보다 `when`이 큰 것만 적용한다. 더 작은 `when`이 나중에 들어오면 오류 없이 건너뛴다.
- **`runMigrations`(`db:migrate`)의 순서** (M5·M7·M6 통합)
  1. 이미 적용한 마이그레이션(같은 hash)의 DB 기록 시각을 지금 journal의 `when`으로 맞춘다. 재번호는 내용이 같으므로 다시 실행하지 않는다.
  2. Drizzle이 건너뛸 낮은 `when`의 마이그레이션을 먼저 적용한다(보충). 단, DB에 지금 폴더에 없는 hash의 기록이 하나라도 있으면 보충하지 않는다.
  3. Drizzle로 나머지를 적용한다.
  4. **적용 누락 검사**: journal의 모든 hash가 DB 기록에 있는지 대조한다. 빠지면 `MigrationGapError`로 멈춘다.
  - 내용이 다른 옛 판(예: 작업 브랜치의 옛 0041)을 적용한 DB는 보충하지 않고 멈춘다. 그 DB는 새로 만든다. 운영 데이터를 지우기 전에 적용 순서부터 바로잡는다.
  - 왜 멈추나: 모르는 기록은 내용이 다른 옛 판이거나 늦게 병합된 것이다. 순서를 바꿔 적용하면 새로 만든 DB와 구조가 달라질 수 있다.
- **새 마이그레이션 작성 권고**: 제약을 지울 때 동적 `DROP CONSTRAINT`(이름을 실행 중에 찾는 문장) 대신 고정한 제약 이름을 쓴다.
  - 왜: Runner의 SQL 설계 추출기는 영향 범위를 모르는 동적 SQL을 만나면 모든 표를 「대조 안 함」으로 둔다(contracts §2.3 「설계」). 이 저장소는 `0006`의 한 문장 때문에 모든 표가 대조 안 함이다.
  - 작성 규칙으로 정할지는 검토 중이다.
- **DB 서버 요구사항** (M5·M7·M6 통합, 자세한 것은 `agent-wbs/packages/db/TESTING.md`)
  - 이미지는 Debian 기반 `postgres:16`이다(`postgres:16-alpine`이 아니다). compose와 시험 컨테이너가 같다.
    - 왜: alpine의 C.UTF-8 정렬 결과가 Debian과 달라 정렬을 확인하는 시험이 실패했다. 기존 alpine 볼륨은 새로 만들거나 `REINDEX DATABASE awbs_dev`가 필요하다.
  - `track_commit_timestamp=on`이 꼭 필요하다(compose·시험 DB·운영). 서버를 시작할 때만 바꿀 수 있으므로 띄우는 명령에 넣는다. 꺼져 있으면 시험 준비가 바로 멈춘다.
  - 시험 DB는 `template0`에서 `LC_COLLATE`·`LC_CTYPE`를 C.UTF-8로 만든다(M7-04 결정 9). 컨테이너 기본 언어가 달라도 정렬·한글 정규식 결과가 같아야 하기 때문이다.
  - 시험 컨테이너에만 `fsync=off`·`synchronous_commit=off`·`full_page_writes=off`를 써도 된다. 개발·운영 DB에는 쓰지 않는다.
- **백업을 다른 DB 서버에 복원할 때의 조건** (M8-06, `agent-wbs/deploy/restore.sh`, `docs/ops/operations.md` §7.2)
  - 보고서 상태 이력은 트랜잭션 번호(`xid8`)로 커밋 시각을 찾는다(`commit_log`·`commit_real`·`state_log`·`global_log`, §2.7).
  - 새 DB 서버는 번호를 작은 값부터 다시 매기므로, 그대로 복원하면 새 변경의 번호가 백업 안의 옛 번호와 겹친다. 겹치면 새 변경의 커밋 시계가 남지 않거나(`awbs_stamp_commit`) 옛 시각으로 읽힌다.
  - 그래서 복원은 새 서버의 번호 epoch(64비트 번호의 위쪽 32비트)를 백업 쪽보다 1 크게 올린 뒤 데이터를 넣는다(`pg_resetwal -e`).
  - **조건: `pg_resetwal -e`는 업무 데이터를 넣기 전의 새 DB 서버를, 정상 종료한 상태에서만 쓴다.** 강제 옵션(`-f`)은 쓰지 않는다.
    - 왜: `pg_resetwal`은 WAL(장애 복구용 변경 기록)도 초기화한다. 켜져 있거나 비정상 종료한 서버, 이미 데이터가 있는 서버에 쓰면 데이터가 깨질 수 있다.
    - 살아 있는 운영 DB의 번호 문제를 이 명령으로 고치지 않는다.
  - 백업 직전에는 쓰기(api·worker)를 멈추고 `awbs_settle_commits()`를 불러 실제 커밋 시각을 `commit_real`에 옮겨 둔다. 실제 커밋 시각은 `pg_dump`에 담기지 않기 때문이다.

### 6.1 DB 권한과 보안 검사

- 표의 소유자는 전용 NOLOGIN 역할(`awbs_data_owner`)이다. 앱이 쓰는 권한은 별도 역할(`awbs_app`)에 모은다.
- 운영 api·worker는 `awbs_app` 권한을 물려받기만 하는 로그인 `awbs_app_login`으로 접속한다(M8-06).
  - 멤버십은 `ADMIN FALSE, INHERIT TRUE, SET FALSE`다. `SET ROLE`로 다른 역할이 될 수 없고, 멤버십을 다시 줄 수도 없다(ADMIN이 남으면 앱이 스스로 SET을 켤 수 있다). migrate는 준 사람(grantor)별 멤버십을 모두 회수한 뒤 다시 준다. 관리자로 접속한 뒤 `SET ROLE awbs_app`으로 낮추는 방식은 쓰지 않는다(`RESET ROLE`로 되돌릴 수 있다).
  - 로그인은 운영 migrate가 만들고 맞춘다(`packages/db/src/app-login.ts`). 비밀번호는 운영 비밀 파일 `db-app-password`에서만 온다.
  - 확인: `awbs-entrypoint db-check`, 시험 `packages/db/test/app-login.db.test.ts`.
  - NOLOGIN은 그 역할로 직접 로그인할 수 없다는 뜻이다.
  - 왜: 앱이 표 소유자나 관리자(superuser) 권한을 가지면 DB 제약과 트리거를 끄고 지나갈 수 있다.
- 높은 권한으로 실행되는 함수(SECURITY DEFINER)는 모두 안전한 검색 경로(`search_path=pg_catalog,pg_temp`)를 고정하고, PUBLIC의 실행 권한을 회수한다.
  - 검색 경로는 이름만 쓴 표·함수를 어느 스키마에서 찾을지 정한 목록이다. 고정하지 않으면 같은 이름의 가짜 함수가 대신 실행될 수 있다.
- 임시 표를 만드는 권한(TEMP)도 PUBLIC과 앱 역할에서 회수한다.
- 표를 새로 만들 때마다 모든 표의 권한과 보호 장치(트리거)를 빠짐없이 검사하는 테스트를 돌린다.
- FK마다 그 열로 시작하는 인덱스(선두 인덱스)가 있는지도 검사한다.
  - 왜: 인덱스가 없으면 가리키는 행을 지우거나 고칠 때 표 전체를 훑느라 느려지고 잠금이 길어진다.

### 6.2 system seed: 모델 순서와 Claude 모델 목록

owner 결정(2026-11-26 아이템 8)을 system seed로 넣는 정의다. 사용량 부족 기준 20%(`exec_policy.low_pct`)는 이미 §2.6에 있다.

- 저장 위치: `app_settings.model_settings`(jsonb) 한 칸이다.
- 초기값의 단일 출처: SQL 함수 `public.default_model_settings()`다. `seed_system()`과 마이그레이션 0016의 기존 행 채우기가 함께 쓴다.
  - shared의 `DEFAULT_MODEL_SETTINGS`와 값이 같아야 하고, DB 테스트가 둘을 대조한다.
  - 왜 한 곳에 두나: 초기값이 두 곳에 있으면 한쪽만 고쳐져 어긋나기 쉽다.
- seed는 행이 없을 때만 넣는다. 팀장이 바꾼 순서를 다시 seed해도 덮지 않는다. 설정까지 지우는 초기화(`keepSettings=false`)는 초기값으로 되돌린다.

**모양** (목록은 모두 아래 등급부터)

```json
{
  "rankOrder": {
    "Claude": ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"],
    "Codex": ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-luna", "gpt-6-astra",
              "gpt-6-sol", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol"]
  },
  "codexFamilyOrder": ["luna", "terra", "astra", "sol"],
  "claudeModels": ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"]
}
```

**값을 이렇게 정한 근거**

- Claude 순서: owner가 정한 Haiku 5.5 < Sonnet 5.5 < Opus 5.5 < Fable 5.2 그대로다.
- Claude 모델 목록: Q-06 승인표(open-questions §0.2)의 Claude 모델 4개다.
- Codex 순서: Q-06 승인표의 Codex 모델(숨김 모델 제외)을 owner 규칙으로 줄 세운 것이다.
  - 세대가 높을수록 위다. 세대는 숫자로 비교한다(5.6 < 6 < 6.1 < 6.2).
  - 같은 세대 안에서는 luna < terra < astra < sol이다.
  - 예: gpt-6.1-sol이 gpt-6.1-terra보다 위다. CLI 목록의 표시 순서와는 다를 수 있다.
- `rank` 값은 이 목록의 위치다. 아래부터 1, 2, …이고 클수록 위 등급이다.

**설정에 없는 새 모델의 자리** [결정 — owner 규칙이 다루지 않은 부분]

- 새 모델은 「미허용」으로 등록한다(G §7.2). 허용하기 전에 팀장이 자리를 확인한다.
- Codex 새 모델은 규칙(세대·계열)으로 자리를 정한다. 규칙상 자기보다 아래인 모델 중 가장 위에 있는 것 바로 위에 넣는다. 팀장이 바꾼 순서는 건드리지 않는다.
  - 예: 초기 순서에 gpt-6.1-astra가 새로 오면 gpt-6.1-terra와 gpt-6.1-sol 사이에 들어간다.
- 계열이 없거나 모르는 계열인 Codex 모델은 그 세대의 맨 아래다(예: gpt-5.5).
- 이름을 읽을 수 없는 Codex 모델과 Claude 새 모델은 맨 아래에 둔다.
- 계산 함수는 shared의 `compareCodexModels`·`placeModel`·`modelRanks`다. 줄 세우기 규칙은 Runner(M4-02)가 쓰던 규칙과 같다.
