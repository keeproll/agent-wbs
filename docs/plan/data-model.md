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
- **project_id**
  - 프로젝트 데이터는 모두 `project_id`(단일 프로젝트지만 초기화 삭제 기준).
  - 설정·환경은 `project_id` 없음.
- **삭제**
  - FK 기본 `ON DELETE RESTRICT`. (가리키는 행이 있으면 지우지 못하게 막는다.)
  - 물리 삭제는 초기화 함수에서만.
  - Task는 `deleted_at` soft delete, CP 취소는 `cancelled`. soft delete는 행을 지우지 않고 「지움」 표시만 하는 방식이다.
  - 왜: 이력과 연결을 잃지 않기 위해서다.
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
  - 단일 행(`id=1` CHECK), `epoch int`, `cleanup_status(none/pending/running/failed)`
  - 근거: §4.2 L261
- `reset_log`
  - epoch, at, actor, deleted_task_count, keep_settings, runner_cleanup_status, finished_at — 프로젝트와 별도 보존
  - 근거: §4.2 L258
- `runner_commands`
  - kind(`reset-cleanup`), epoch, payload(저장소·기준 커밋·브랜치·경로), status, attempts, result
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
  - key PK, ciphertext(암호화된 값), nonce(암호화할 때 한 번만 쓰는 난수), key_version, last4
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
  - unique(project, v), commit_sha unique(project), files, md_list, changes, instruction, result — 추가 전용
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
  - 근거: P TASK-0004
- `tasks`
  - task_key unique, wbs_node_id, sort_order, title(1~200), work_type, primary_domain, related_domains[], priority(0~3), assignee/verifier_agent, **status**(§3.1), verif_state, planning_approved_at, fix_start, act_start/act_end, conflict_group, src_input_version, deleted_at.
  - CHECK `primary_domain <> ALL(related_domains)`.
  - `wbs_path`는 저장하지 않고 계산(§9.1-1).
  - 근거: §5.2 §5.3
- `task_specs`
  - task PK, overview(jsonb: 목적·배경·범위·제외·선행/완료 조건), spec(jsonb: req·work·steps·inputs·outputs·files·constraints·errors·docs·verify), ac(jsonb[] given/when/then/method)
  - AC(Acceptance Criteria)는 「이렇게 되면 완료로 인정한다」는 수용 기준이다.
  - 근거: §4.4, P `SPEC_GROUPS`
- `task_outputs`
  - name, kind, required, verify, delivered, delivered_attempt
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
  - 근거: §7.1
- `task_subagents`
  - role, subagent_id, basis
  - 근거: §7.4
- `task_splits`
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
  - 근거: §4.5
- `change_proposals`
  - cp_key, source(planning/message/manual/split/input/decision), status(§3.6), ops(jsonb §5.6), id_map, preview_hash
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
  - 근거: D-03
- `runner_job_events`
  - 추가 전용: prepared·prestart_failed·started·lease_lost·reconciled·finished, code, detail — **시작 전 실패 기록**
  - 근거: §1.2-4 §7.4-4
- `execution_holds`
  - job unique, attempt?, epoch, host_id?, boot_id?, fence?, pgid/cgroup, task?, conflict_group?, agent, slots, heavy, **slot_state**, **lock_state**, lock_from_job?, handed_to_job?, release_proof(`no_process/group_empty/boot_changed`), closed_at.
  - 별도 `state` 컬럼 없음 — 정의는 §2.5-1.
  - 닫히기 전 삭제 금지(초기화는 §5).
  - 근거: §6.7 L795·804-806
- `external_write_authority`
  - 단일 행: host_id, generation, state(`granted/blocked`), credential_fingerprint, blocked_reason, reconciled_at — GitHub(git 저장소를 호스팅하는 서비스) 등 공유 외부 쓰기 권한
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

job 하나에 보유 행 하나. 물리 슬롯과 논리 잠금은 두 축이며 **전체 상태는 저장하지 않고 계산**한다.

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
  - CLI 재기동은 `none→reserved→active`를 다시 밟는다.
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
  - host_id, cpu, cores, mem/swap/disk, os, per_session_gb, samples, seen_at(이력)
  - 근거: §6.6
- `runner_concurrency_log`
  - limit, running, subagents(관측/보유), heavy, resources, adjust(from/to/reason)
  - 근거: §6.6
- `concurrency_settings`
  - mode(auto/manual), caps, mem_reserve_gb, subagent_budget(dev/qa)
  - 근거: §6.6 §6.7
- `runner_readiness`
  - key, status, detail, fix, at
  - 근거: §7.4
- `agent_usage`
  - agent, remain_pct(0~100), reset_at, tokens_used
  - 근거: §6.2
- `agent_models` / `agent_efforts`
  - `agent_models`: 보고값, rank, allowed(신규=false), is_new
  - `agent_efforts`: **CLI×모델별** 값→공통 1~5 명시 매핑(owner Q-06 승인표, ultra·미확인은 미매핑=사용 안 함)
  - 근거: §7.2
- `exec_policy`
  - on_usage, low_pct(사용량 부족 기준, 기본 20% — owner 2026-11-26), on_rework, esc_notify, floors, live_inject, auto_retry_limit=2, auto_rework_limit=3
  - 근거: §7.3, owner Q-04
- `subagent_defs`
  - id, version, agent, role, tools, sandbox(프로그램이 건드릴 수 있는 범위를 막아 둔 실행 환경), text, hash, allowed, ref — 버전 불변
  - 근거: §7.4
- `cli_observation_grades`
  - cli+version+model+options unique, grade, verified_at, notes
  - 근거: §6.7

### 2.7 일정 · 보고서 · 알림 · 설정

- `schedule_policy`
  - auto_replan, cp_auto, threshold_days, assume_rate, window_days=7, min_hours=72
  - 근거: §6.4 §10
- `blackout_days`
  - date unique, note
  - 근거: §6.2
- `schedule_baselines` / `baseline_items`
  - `schedule_baselines`: unique(project, v), 예상·범위·적용 가동률
  - `baseline_items`: Task별 시작·종료·lo·hi — 추가 전용
  - 근거: §6.4
- `replans` / `replan_moves`
  - `replans`: rp_key, trigger, actor, baseline_v?, status(`applied/pending`), before/after
  - `replan_moves`: Task별 이동·신규·제외
  - 근거: §6.4
- `reports`
  - kind, from, to, view 기본값, snapshot(jsonb), generated_at, due_at, reason.
  - 정기: unique(project, kind, from, to) 부분 인덱스. **불변**
  - 근거: §4.11 §8.5
- `report_pdfs`
  - report, view, path, sha256 (캐시)
  - 근거: §8.5
- `mail_settings`/`mail_recipients`
  - `mail_settings`: SMTP(비밀값은 secrets)
  - `mail_recipients`: email lower unique, daily/weekly 하나 이상 또는 inactive. 외부 수신자·링크 제외 필드는 Q-13에서 필요할 때 추가
  - 근거: §4.11
- `mail_outbox` / `mail_log`
  - `mail_outbox`: delivery_id(논리 발송), epoch, unique(report, recipient, try_no), state(§3.7)
  - `mail_log`: 수신자 삭제 후에도 주소 보존
  - 근거: §9.6-6
- `notify_settings`/`notify_rules`
  - `notify_settings`: enabled, chat_id, target_name, bot, 테스트 입력 지문
  - `notify_rules`: 이벤트 6종
  - 근거: §4.14
- `notify_events`
  - dedup_key, resolved_at, dup_count. **열린 키 1개**(부분 unique where resolved_at is null)
  - 근거: §8.7
- `notify_outbox` / `notify_log`
  - `notify_outbox`: delivery_id, epoch, 대기·시도·next_at
  - `notify_log`: 업무·테스트, 상태, 오류 요약
  - 근거: §8.7
- `alerts`
  - 대시보드 현재 상태 알림: key unique(열림), severity, target
  - 근거: §4.1 §4.14 L522
- `app_settings`
  - app_url, heartbeat 주기·누락 횟수, 분할 기준, 작업 흐름 기본값, 시간대
  - 근거: §4.9
- `github_settings`
  - mode, status, scopes, expires_at, account
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
  - drift는 계약 문서와 실제 코드가 서로 어긋난 상태다.
  - 근거: §4.12 §9.6-1-4
- `ci_runs` / `ci_steps`
  - run_key, stage, **base_sha, head_sha, merge_sha, tree_sha, pipeline_sha**(단계별 해당 값), ref, pr, task?, attempt?, trigger, status, fail_step, log_excerpt, artifact_path, url
  - 근거: §4.13
- `merge_queue`
  - pr, task unique(열림), position, status, qa_head_sha(H), synced_head_sha(H'), base_sha(A), verification, ci_run, tested_tree_sha, **actual_merge_sha·actual_tree_sha**
  - A·H·H'의 뜻은 [contracts §4.1](contracts.md#41-시도-1회) 「코드 근거 고정」 3번에 있다.
  - 근거: §4.13
- `flaky_tests`
  - test_key, rate, quarantined, task
  - 근거: §4.13
- `ci_settings`
  - night_at, retry=1, deploy_url
  - 근거: §4.13
- `messages`
  - msg_key, task, attempt?, dir, type, to_agent, body, **delivery**, **pending_next**, **work_state**, fail_reason, read_at, draft — 세 상태 별도(§9.4-1)
  - 왜 세 상태를 따로 두나: 「전달됐다」「다음 실행에 넣을 예정이다」「Agent가 일을 끝냈다」는 서로 다른 사실이다.
  - 근거: §4.10
- `task_history`
  - 추가 전용: at, actor, task?, kind, text, before, after, ref
  - 근거: §4.9 §9.1-3
- `idempotency_keys`
  - unique(principal, key), request_hash, response, epoch
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
- **claim은 job 예약만 하고 시도를 만들지 않는다.**
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

### 3.4 프로젝트/초기화

- `none → boot(analyzing → tech_wait → drafting → approval_wait) → active`.
- 어느 상태에서나 초기화 → `none` + epoch+1 + 정리 `pending`.
- 정리 완료 전 bootstrap job claim 금지(§4.2 L261).

### 3.5 CI · 병합 대기열

- CI: `queued → run → pass | fail | skip`.
- 대기열: `waiting_verify → queued → checking → merged | failed | removed`.

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
3. 프로젝트 데이터 삭제. `keepSettings=false`면 설정·환경·Runner 가동 기록·메일/Telegram 설정도 삭제. **GitHub 연결은 항상 유지**(§4.2 L258), 전송 이력은 항상 삭제.
4. epoch+1, `reset_log` 추가. 1~4는 한 트랜잭션(§9.5-1).
   - 왜 한 트랜잭션인가: 중간에 실패하면 반쯤 지워진 상태가 남지 않고 전부 원래대로 돌아간다.
5. 커밋 후 worker가 파일 삭제, Runner가 정리 실행. 실패는 재시도. 보유 중인 실행 목록(pgid·cgroup·host·boot)은 정리 명령 payload로 옮겨, 그룹 종료가 확인되어야 정리 완료로 본다.

### 5.1 epoch 원자성

epoch가 바뀌는 순간(초기화)과 다른 쓰기가 겹쳐도 옛 프로젝트 데이터가 새 프로젝트에 섞이지 않게 하는 규칙이다.

- **모든** 변경 트랜잭션(팀장·Runner·worker, 환경 행 포함)은 첫 문장으로 `system_state`를 `FOR SHARE`로 잠그고 epoch를 다시 확인한다.
  - 초기화만 `FOR UPDATE`.
  - middleware(모든 요청이 처리 전에 거치는 공통 코드) 검사만으로 쓰지 않는다.
  - 왜: middleware에서 확인한 뒤 실제로 쓰기 전 사이에 초기화가 끼어들 수 있다.
- 잠금 순서: `system_state → projects → tasks(id순) → jobs/holds → 그 외`. 역순 금지.
  - 왜: 모두 같은 순서로 잠가야 서로 상대 잠금을 기다리는 교착(deadlock)이 생기지 않는다.
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
  - `system`: G가 확정한 기본 정책·분할 기준, owner 확정 Q-03 값·Q-04(자동 재시도 2·재작업 3)·Q-06 매핑, 검토를 마친 하위 Agent v1 — M5-06
  - `demo`: P `MOCK` 12 Task·`SUB_MOCK`·Q 미승인 잠정값 — **테스트·화면 검증 전용**, 운영 DB에서 실행 거부
- 추가 전용 보장 테스트: 앱 역할로 UPDATE/DELETE가 거부되는지 확인.
