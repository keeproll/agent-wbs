# 하위 Agent v1 정의 검토 기록 (M5-06)

이 파일은 실제 하위 Agent v1 정의를 누가, 무엇을 기준으로 검토했는지 남기는 기록이다.

- `pnpm subagents:check`는 아래 「검토한 정의」 표에 정의 이름·버전·hash가 그대로 있는지 확인한다.
  - 왜: 정의 파일을 고치면 hash가 바뀐다. 표의 hash와 달라지면 다시 검토하지 않은 내용이 seed로 들어가는 것을 막을 수 있다.
- 정의 파일을 바꾸면 새 버전 파일을 만들고, 다시 검토한 뒤 이 표에 새 줄을 더한다. 이미 있는 줄은 지우지 않는다.

## 검토 기준

1. D-24(architecture): P `SUB_MOCK`은 demo fixture로만 쓴다.
   - 실제 v1은 제품 제약·정책에 맞춰 새로 쓴다.
   - 관리 대상 스택(예: 특정 화면·서버·DB 라이브러리)이나 Runner 계약 전용 지시를 일반 정의에 고정하지 않는다.
   - 외부 하위 Agent 모음은 설치하지 않는다.
2. G §7.4: 모델·Effort는 정의에 적지 않는다. Runner가 설치할 때 실행 정책 등급으로 채운다.
3. G §6.7: hook을 쓰지 않는다. 그래서 정의에도 hook 설정을 두지 않는다.
   - 세션 안의 하위 Agent 수는 지시문 예산으로 통제한다. 그래서 하위 Agent가 또 하위 Agent를 띄우지 않게 한다.
4. data-model §6: down migration은 채택하지 않는다. 운영 되돌림은 백업 복원과 앞으로 고치는 마이그레이션으로 한다.
5. G §7.4-2: 하위 Agent는 반드시 쓰는 것이 아니다. 정의는 부모 세션이 맡기는 보조 일만 다룬다.
6. 품질을 좌우하는 것은 Task 명세·제외 범위·Acceptance Criteria·Completion Gate·실행 정책이다(G §7.4). 그래서 모든 정의가 「부모 세션이 넘긴 Task 지시문」을 기준으로 일한다.

## 자동 검사 항목 (`pnpm subagents:check`)

| 규칙 | 무엇을 막나 |
| --- | --- |
| `hash` | manifest hash와 파일 내용의 sha256이 다른 경우 |
| `version` | 버전이 1 이상의 정수가 아니거나, 파일 이름의 버전과 다르거나, 같은 정의·버전이 두 번 있는 경우 |
| `review` | 이 파일에 정의·버전·현재 hash 줄이 없는 경우 |
| `model-effort` | 설정 키 `model`·`effort`·`model_reasoning_effort` 등, 또는 지시문 속 모델 이름 |
| `config-key` | 허용하지 않은 설정 키(예: `hooks`, `permissionMode`, `approval_policy`, `mcp_servers`). Codex의 `sandbox_mode`도 여기서 거부한다(아래 「권한」) |
| `tools` | 허용 목록 밖 도구, Claude `tools` 줄 생략·빈 값, 파일과 manifest의 도구 차이, 권한 표시와 실제 권한의 차이 |
| `mock-text` | Mock 정의 이름을 그대로 쓰거나 SUB_MOCK 문장을 옮겨 온 경우 |
| `conflict` | 위 검토 기준 1·4와 충돌하는 지시 |
| `common-rules` | 공통 규칙 블록(`common-rules.md`)이 빠지거나 바뀐 경우 |
| `format`·`name` | 파일을 UTF-8로 읽을 수 없거나, 맨 앞 BOM·CR·제어 문자(C0·DEL·C1)·비문자가 있는 경우. 그다음 표준 분석기로 읽어 실패하는 경우(아래 「파일 읽기」). 파일 안 name과 정의 이름의 차이, 빈 description |

### 파일 읽기 — 표준 분석기를 쓴다

- 기준: 검사기는 CLI(Claude Code·Codex)가 실제로 읽는 방식보다 관대하면 안 된다.
  - 왜: 검사와 seed가 성공해도 CLI가 파일을 읽지 못하면 정의가 조용히 빠진다. Claude Code는 YAML이 깨진 Agent 파일을 건너뛴다.
- 손으로 만든 해석을 쓰지 않는다. 손으로 만든 해석은 탭·제어 문자처럼 생각하지 못한 경우를 놓친다(리뷰 P2-3·재리뷰).
- 순서는 다음과 같다.
  1. 파일 바이트를 UTF-8로 엄격하게 읽는다. 잘못된 바이트를 다른 글자로 바꾸지 않고 실패로 본다.
  2. 문자를 거른다. 탭·LF와 YAML 1.2 §5.1·TOML 1.0이 함께 받는 글자만 허용한다.
     - BOM·CR·C0 제어 문자·DEL·C1 제어 문자(U+0080~U+009F)·비문자(U+FFFE·U+FFFF)는 받지 않는다.
     - C1 제어 문자는 TOML은 받지만 YAML은 받지 않는다. 두 형식에 같은 기준을 쓰려고 함께 막는다.
  3. Claude frontmatter는 `yaml` 패키지(YAML 1.2, `strict`·`uniqueKeys`)로 읽는다.
     - 문서는 하나여야 하고, 오류와 경고가 모두 0건이어야 한다. 경고도 오류로 본다.
     - 앵커·별칭·태그를 쓰지 않는다. 값은 모두 문자열 하나다.
     - YAML 1.1로 읽은 결과도 같아야 한다. Claude Code가 쓰는 YAML 분석기의 버전을 확인하지 못했기 때문이다.
       - 예: `yes`는 YAML 1.1에서 참·거짓 값, 1.2에서 문자열이다. 이런 값은 받지 않는다.
  4. Codex 파일은 `smol-toml`(TOML 1.0)로 읽는다. 최상위 값은 모두 문자열이어야 한다.
- 검사기는 표준보다 좁게 받을 수는 있어도, 표준이 거부하는 파일을 받지는 않는다.

## 사람이 본 항목 (작성자 검토)

- 정의마다 「맡은 일」 첫 줄이 한 가지 일만 말한다.
- Claude 읽기 전용 정의(`change-reviewer`·`contract-checker`)는 `Read`·`Glob`·`Grep`만 가진다.
  - Claude는 `tools` 줄에 적은 도구만 하위 Agent에 준다. 그래서 이 두 정의의 「읽기 전용」은 도구 목록이 지킨다.
  - Bash도 주지 않았다. Bash로는 파일을 쓸 수 있어서 「읽기 전용」 표시가 거짓이 되기 때문이다.
  - `tools` 줄을 생략하면 부모의 도구를 모두 물려받는다. 그래서 검사기는 `tools` 줄이 없거나 비면 실패로 본다.
- `doc-editor`는 문서를 고쳐야 해서 Edit·Write가 있다. 명령 실행 도구(Bash)는 주지 않았다.
  - Edit·Write는 경로를 고를 수 없다. 그래서 「문서 파일만 고친다」는 제한은 도구가 아니라 지시문으로 둔다.
  - 권한 표시도 「worktree 쓰기 · 문서만(지시문)」으로 적어, 도구가 막는 범위와 지시문이 막는 범위를 구분한다.

### 권한 — Codex 정의는 부모 세션의 권한을 물려받는다

- Codex 하위 Agent 역할 파일에 적은 `sandbox_mode`는 적용되지 않는다.
  - 하위 Agent는 부모 세션의 sandbox(파일 읽기·쓰기 범위를 막는 실행 환경)와 승인 정책을 그대로 물려받는다.
  - 근거: openai/codex 소스 `codex-rs/core/src/agent/role.rs`의 `AgentRoleOverrides`에는 `sandbox_mode`가 없다. 같은 폴더 `child_config.rs`의 `apply_spawn_agent_runtime_overrides`가 부모의 승인 정책·권한을 자식에 복사한다. 시험 `apply_role_preserves_parent_sandbox_permissions`(`role_tests.rs`)도 이를 확인한다. Context7로 최신 소스를 확인했고, 리뷰는 같은 내용을 `rust-v0.172.0`에서 확인했다.
  - 역할 파일이 바꿀 수 있는 것은 지시문·모델 관련 값과, `[features]`로 일부 기능을 끄는 것뿐이다. 모델 관련 값은 이 시스템에서 금지다.
- 그래서 v1 Codex 정의는 `sandbox_mode`를 적지 않는다. 적으면 권한을 보장하는 것처럼 보이므로 검사기가 거부한다.
- Codex 정의의 권한 표시는 「부모 세션 권한 상속」으로 시작한다. 읽기 전용·쓰기 권한을 약속하지 않는다.
  - 「수정 금지」「테스트만」 같은 제한은 지시문 제한이다. 표시에도 「(지시문)」을 붙인다.
  - 예: 부모 세션이 쓰기를 허용하면 `security-checker`도 기술적으로는 파일을 고칠 수 있다. 막는 것은 지시문뿐이다.
- Codex 도구 표시는 모두 `shell · apply_patch`다. 역할 파일로 도구를 고를 수 없어 부모 세션의 도구를 물려받기 때문이다.
- 읽기 전용이 꼭 필요한 검사를 기술적으로 보장하려면 Runner가 그 세션을 읽기 전용으로 시작해야 한다. 이 결정은 정의가 아니라 Runner 실행 정책의 일이다. 아래 「M8 확인 목록」에 남긴다.

### M8 확인 목록 (실측이 필요해 지금 확인하지 않은 것)

실제 CLI 실행은 유료 호출이라 M5-06에서 하지 않았다. 다음은 M8-04(최신 Codex·Claude의 하위 Agent 관측 확인)에서 실제로 확인한다.

1. 설치된 Codex 버전에서 역할 파일의 `sandbox_mode`가 무시되고 부모 권한을 물려받는지.
2. 부모 Codex 세션이 `read-only`일 때 `ac-verifier`·`test-author`가 테스트 실행·테스트 파일 작성을 할 수 없는지, 이때 BLOCKED로 보고하는지.
3. Codex 검증(qa) 세션을 Runner가 어떤 sandbox로 시작해야 `security-checker`·`failure-investigator`의 수정 금지를 기술적으로 보장할 수 있는지.
4. Claude Code가 `tools: Read, Glob, Grep` 정의에 다른 도구를 주지 않는지, `tools` 생략 시 부모 도구를 물려받는지.
5. Claude Code와 Codex가 v1 정의 10개를 실제로 읽어 들이는지(YAML·TOML 분석 오류로 건너뛰지 않는지).
6. Claude Code의 frontmatter YAML 분석기와 버전, Codex의 TOML 분석기 버전(TOML 1.0/1.1). 검사기보다 관대하거나 엄격한 부분이 있는지.

- 모든 정의가 검증 결과를 「부모 세션에 보고」한다. Runner 보고 경로·결함 등록 같은 Runner 계약은 부모 세션의 몫이다.
- SUB_MOCK과 이름이 겹치지 않는다. demo 정의와 실제 정의가 한 DB에 함께 있어도 섞이지 않게 하려는 것이다.
- `planner-estimator`에 해당하는 정의는 두지 않았다.
  - Task 지정 역할은 개발(dev)·검증(qa) 둘뿐이고(`task_subagents.role`), Mock에서도 Planning 전용·미허용이었다.

## 검토한 정의

| 정의 · 버전 · hash | Agent | 역할 |
| --- | --- | --- |
| `ui-builder` v1 `bbf10fd4a061bb11b5e1f09d08b3048f569fe91786ed5d12bcf984337587584b` | Claude | 화면 구현 |
| `service-builder` v1 `bebddb297b2a3567f0399ea32838aac3169e97c1e836a315d367afc63ed97bfe` | Claude | 서버 기능 구현 |
| `schema-migrator` v1 `28a0f102e176580d529eac3655a1a538add336c0d67f1fc79d82cd09180df2f6` | Claude | DB 구조 변경 |
| `change-reviewer` v1 `4b2a5c2d094379dab7ab8f29f15f3ffd45b902d8a8506279e3808a31b0ed5adf` | Claude | 변경 검토 |
| `contract-checker` v1 `d64fb63a709ea059ccc43bc50d16ff577c74ceea3dbb9569f5e10af0865a895d` | Claude | 인터페이스 계약 대조 |
| `doc-editor` v1 `ac2a210a893583b08f205eaac37852062cbcf70d4615719d5a68e7ba90e0939e` | Claude | 문서 작성 |
| `ac-verifier` v1 `2e532748bd491c4244e901b19c5952ec92ee3918cf8c96430ba22eea4b1179b4` | Codex | 인수 조건 검증 |
| `test-author` v1 `ee8ea3abdeaf2707c46e263bed68ac0ad65843cecebf7db13008b2e3629758b3` | Codex | 테스트 작성 |
| `security-checker` v1 `118453d3a627f3cbee47486ff3afee8e74ad23a877dba34050758a84c4ce310f` | Codex | 보안 점검 |
| `failure-investigator` v1 `83750c10ed0353dff7cc894336ce80529c30dac50d8cd201161fa46eb41a6ef6` | Codex | 실패 원인 조사 |

## 검토자

- 작성자 검토: Claude (M5-06 담당), 2026-11-27. 위 「사람이 본 항목」과 자동 검사 통과.
- 교차 검토: Codex (M5-06 리뷰 담당) — **대기**. 리뷰 결과와 지적 처리는 이 절에 이어서 적는다.
