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
| `config-key` | 허용하지 않은 설정 키(예: `hooks`, `permissionMode`, `approval_policy`, `mcp_servers`)와 `danger-full-access` |
| `tools` | 허용 목록 밖 도구, 파일과 manifest의 도구 차이, 권한 표시와 실제 도구·sandbox의 차이 |
| `mock-text` | Mock 정의 이름을 그대로 쓰거나 SUB_MOCK 문장을 옮겨 온 경우 |
| `conflict` | 위 검토 기준 1·4와 충돌하는 지시 |
| `common-rules` | 공통 규칙 블록(`common-rules.md`)이 빠지거나 바뀐 경우 |
| `format`·`name` | 읽을 수 없는 파일 모양, 파일 안 name과 정의 이름의 차이, 빈 description |

## 사람이 본 항목 (작성자 검토)

- 정의마다 「맡은 일」 첫 줄이 한 가지 일만 말한다.
- 읽기 전용 정의(Claude `change-reviewer`·`contract-checker`, Codex `security-checker`·`failure-investigator`)는 쓰기 도구가 없다.
  - Claude 읽기 전용 정의에는 Bash도 주지 않았다. Bash로는 파일을 쓸 수 있어서 「읽기 전용」 표시가 거짓이 되기 때문이다.
- `doc-editor`는 문서를 고쳐야 해서 Edit·Write가 있다. 명령 실행 도구(Bash)는 주지 않았다. 문서만 고친다는 제한이 도구로도 지켜지게 하려는 것이다.
- Codex `ac-verifier`·`test-author`는 `workspace-write`다.
  - 테스트 실행이 빌드 결과·캐시 파일을 만들기 때문이다. 구현 코드를 고치지 않는다는 제한은 지시문으로 둔다.
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
| `ac-verifier` v1 `095739ddc86fa0338eecc85c9a855e94e080a66331a8074ebf0e054ec5453ecb` | Codex | 인수 조건 검증 |
| `test-author` v1 `9d44c885cea53ff8d9d0c22a24a77279dcb3ddd6faa2df39fbbd1caac1fc7c06` | Codex | 테스트 작성 |
| `security-checker` v1 `5c95c520aebd8f75f3ee9c9b79f36da308faa10041716e136e61bed494fc6345` | Codex | 보안 점검 |
| `failure-investigator` v1 `8812cd701e2d12fa442aa0db2d41f8048d27f704ce191d34912d20fdeff4f0b3` | Codex | 실패 원인 조사 |

## 검토자

- 작성자 검토: Claude (M5-06 담당), 2026-11-27. 위 「사람이 본 항목」과 자동 검사 통과.
- 교차 검토: Codex (M5-06 리뷰 담당) — **대기**. 리뷰 결과와 지적 처리는 이 절에 이어서 적는다.
