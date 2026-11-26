# Planning orchestration (M5-04)

이 폴더는 Runner 안의 Planning Agent(계획을 세우는 Agent) 작업을 **단계별로 차례로 엮어 실행**한다. 이렇게 여러 단계를 엮어 실행하는 것을 orchestration이라고 부른다.

맡는 job 종류는 다섯 가지다.

- `bootstrap`: 초기 분석
- `input_diff`: 입력 자료 차이 분석
- `planning`: CP 판단, Planning 세션
- `estimate`: 추정·재추정
- `split`: 분할 제안

실제 Claude·Codex CLI는 부르지 않는다. Agent는 `PlanningAgent` 포트(바깥 구현을 끼워 넣는 자리)로만 받는다. 실제 CLI 연결은 M5-01·M5-02에서 한다. 시험은 손으로 쓴 가짜 Agent를 쓴다.

## 쓰는 법

```ts
import { PlanningCheckpoints, runPlanningJob } from './planning/index.ts';

const outcome = await runPlanningJob(job, {
  api, epoch, runnerId,
  checkpoints: await PlanningCheckpoints.open(awbsHome),
  workspace,                       // PlanningWorkspace: check·unzip·repo·diff 단계
  agents: { Claude, Codex },       // PlanningAgent 두 개
});
// outcome.status: 'done' | 'failed' | 'lost'
```

- `job`은 job 계층이 `POST /runner/jobs/claim`으로 받은 것이다.
- 임대 받기·시작·연장·종료(claim·start·renew·finish)는 이 폴더가 하지 않는다. job 계층(M5-05 `src/jobs`)의 일이다.
  - 왜: 시도(attempt) job과 같은 수명 관리를 한 곳에서 해야 lease(임대)와 fence(낡은 Runner의 보고를 막는 번호표) 처리가 갈라지지 않는다.
- 결과를 finish에 쓰는 법:
  - `done`·`failed`: 그대로 `POST /runner/jobs/:id/finish`의 `status`·`result`·`error`로 보낸다.
  - `lost`: 임대 상실(`LEASE_LOST`), 초기화 번호 변경(`EPOCH_MISMATCH`), 인증 거부다. 서버가 이 job의 보고를 더 받지 않으므로 finish도 보내지 않는다.

## job별 흐름

### 초기 분석 `bootstrap` (G§4.2 ①, P L4488-4489)

1. `check` GitHub 접근 · 커밋 고정
2. `unzip` 입력 자료 checkout
   - `prototype/`만 읽기 전용 사본으로 꺼낸다.
   - 안의 스크립트·설치 명령은 실행하지 않는다.
3. `repo` 작업 준비
   - 로컬 clone, 없는 `src/`·`contracts/`·`.agentwbs/` 생성 커밋, 기준 커밋 기록이다.
4. `codex` Codex 독립 분석
5. `claude` Claude 독립 분석
   - 독립 분석이므로 상대 Agent의 분석을 넘기지 않는다.
   - 왜: 먼저 나온 분석을 보면 두 번째 분석이 그쪽으로 끌려가 「두 Agent 합의」의 의미가 약해진다.
6. `cross` 교차 검토 · 이견 조정
   - 작성자가 두 분석을 함께 보고 합의안을 쓴다.
   - 끝나면 기술 결정 제안을 보낸다(`POST /planning/bootstrap/:jobId/tech`).
7. `tech` 기술 결정 확정은 **팀장 단계**다.
   - Runner는 이 단계를 보고하지 않고 job을 `done`(결과 `{waiting:'tech'}`)으로 끝낸다.
   - 팀장이 확정하면 서버가 `resumeStep=draft`인 새 job을 만든다.
8. `draft` WBS 초안 작성
   - 작성자가 초안을 쓰고, 두 Agent가 각 Task를 **독립 추정·독립 판단**한다.
   - 합친 결과를 `POST /planning/bootstrap/:jobId/draft`로 보낸다.
   - `draft` 완료는 서버가 초안 등록 때 기록한다. 그래서 Runner는 `draft:run`만 보고한다.

재분석(`runNo` 2 이상)은 Codex 분석부터 다시 한다. 확정된 기술 결정은 유지하므로 기술 결정을 다시 제안하지 않는다(G§4.2).

### 차이 분석 `input_diff` (G§4.2 ②, P L4490)

1. `check` 팀장이 고정한 커밋 확인
2. `unzip` 입력 checkout
3. `diff` 이전 입력 커밋과 git diff
4. `impact` 두 Agent가 같은 diff를 각자 영향 분석
5. `cp` 작성자가 CP(Change Proposal, 변경 제안)를 쓴다
   - 새 Task의 판단은 두 Agent 합의로 채운다.
   - `source.kind=input`으로 제출한다. 어느 입력 작업에서 왔는지는 서버가 job으로 정한다.
   - 영향이 없으면 CP 없이 `cp` 단계를 「변경 없음」으로 끝낸다. CP는 변경이 1개 이상이어야 하기 때문이다.

### Task 단위 job

- `planning` + `proposal`: 저장된 CP의 판단이다.
  - 두 Agent가 「변경 후」 내용을 각자 판단한다.
  - 합의한 기록에 작업 payload의 `subjectHash`를 그대로 붙여 `POST /planning/proposals/:id/judgements`로 보낸다.
  - 분할 CP면 AC 의미·계층 순서·테스트 포함(`splitJudgements`)도 같은 방식으로 판단하고 `splitSubjectHash`를 붙인다.
  - 켜진 규칙(`policy.judgedRules`)만 판단한다.
- `planning` + `payload.planning`: Planning 세션(G§4.5)이다.
  - 두 독립 분석을 `/planning/sessions/:id/analyses`로, 교차 검토를 `/reviews`로 보낸다.
- `estimate`: 두 Agent의 독립 추정을 합쳐 `POST /planning/estimates`로 한 번에 보낸다.
  - 등급 재판단(`policy.rejudge`)이면 대상 Task의 등급 판단(`POST /planning/tasks/:taskKey/plan`)을 먼저 보낸다.
  - 작성자가 충돌 묶음을 말하지 않으면 지금 묶음을 유지한다. 왜: `conflictGroup:null`을 보내면 묶음이 풀린다.
- `split`: 작성자가 나눈 CP에 판단을 붙여 분할 CP(`source.kind=split`, `id`=원래 Task)로 제출한다.
  - 새 Task의 분할 근거가 비었으면 보내지 않고 실패한다.
  - 왜: 근거 문장을 지어 넣으면 판단한 적 없는 분할이 판단한 것처럼 보인다(data-model §2.3).

## 다시 이어 하기(resume)

단계가 실패하면 그 단계를 `fail`로 보고하고 job을 `failed`로 끝낸다. 팀장이 「다시 시도」를 누르면 서버가 같은 Planning 작업에 새 job(`resumeStep`=실패한 단계)을 만든다.

- 재개 단계부터 실행하고, 그 앞 단계는 다시 보고하지 않는다.
  - 왜: 서버에서 이미 「완료」다.
- 앞 단계 중 Agent 단계의 결과가 이 PC의 진행 기록에 없으면, 가장 이른 그 단계부터 다시 실행하고 보고한다.
  - 예: 다른 PC에서 `draft`부터 하라는 job을 받으면 Codex·Claude 분석과 교차 검토부터 다시 한다.
  - 왜: Runner가 서버에서 이전 분석을 읽는 API는 없다(contracts §3.2 「Runner는 payload만으로 판단」). 결과 없이 초안을 쓰면 근거가 없다.
- 앞 단계 중 작업 공간 단계는 보고 없이 다시 마련한다.
  - 예: 분석하려면 읽기 전용 입력 사본이 이 PC에 있어야 한다.
  - 원격 쓰기가 있는 `repo` 단계는 다시 하지 않는다.
- 기술 결정 제안이 거부되면 `cross` 단계 실패로 보고한다.
  - 왜: `tech`는 팀장 단계라 Runner가 실패로 보고할 수 없다. `cross` 실패로 두면 「다시 시도」가 교차 검토부터 다시 하고 제안도 다시 보낸다.

진행 기록(checkpoint, 다시 이어 하기 위한 저장점)은 `AWBS_HOME/state/planning/`에 둔다.

- Planning 작업마다 파일 하나다.
- 분석 결과는 회차(`runNo`)별로 둔다. 재분석은 이전 회차 결과를 쓰지 않는다.
- 쓰기는 임시 파일·fsync(디스크에 실제로 썼는지 확인)·이름 교체 순서다.
- 깨진 기록은 고쳐 쓰지 않고 `CHECKPOINT_UNREADABLE`로 실패한다. 왜: 지우면 이미 보낸 요청의 멱등 키를 잃는다.

## 두 Agent 합의 규칙(`consensus.ts`)

판단 기록(`judgedRules`·`splitJudgements`)은 두 Agent가 **같은 결론**일 때만 남긴다.

- 합의하면 `agreedBy: ['Claude','Codex']`, 근거는 두 Agent의 근거를 한 줄씩 적는다.
  - 예: `Claude: 단독 커밋으로 되돌릴 수 있음` 다음 줄에 `Codex: 공통 코드 변경 없음`.
- 아래 경우는 기록하지 않는다. 이유는 결과의 `disagreements`에 남긴다.
  - `disagree`: 결론이 다름
  - `missing`: 한쪽이 답하지 않음
  - `blank_basis`: 근거가 빔
  - `ambiguous`: 같은 규칙을 두 번 답함
- 왜: 판단 기록은 합의 주체가 둘 다일 때만 유효하다(data-model §2.3-1). 기록이 없으면 서버가 `JUDGEMENT_MISSING`으로 승인을 보류하고 팀장 화면에 보인다. 한쪽 결론을 합의처럼 적으면, 합의하지 않은 분할이 승인을 통과한다.
- 새 Task·초안·새 CP의 판단에는 `subjectHash`를 넣지 않는다. 서버가 저장할 때 계산한다.
- 저장된 대상의 재판단에는 작업 payload의 hash를 그대로 돌려보낸다. 서버가 지금 내용과 대조해 바뀌었으면 `VERSION_CONFLICT`로 거부한다.

추정 합의는 계획 문서에 공식이 없어 Runner가 정한 규칙이다.

- 낙관은 작은 쪽, 비관은 큰 쪽이다. 왜: 한 Agent라도 그만큼 걸릴 수 있다고 봤다.
- 예상은 두 값의 평균(0.1시간 단위)이다.
- 신뢰도는 낮은 쪽, 토큰은 큰 쪽이다.
- 한쪽 추정이 없거나 `낙관 ≤ 예상 ≤ 비관`이 아니면 합의할 수 없어 실패한다.
- 예: Claude 2h(1~4h, 상), Codex 4h(2~6h, 하) → 3h(1~6h, 하), `agreedBy: ['Claude','Codex']`.

## 보고와 멱등

보고는 `PlanningReporter`가 보낸다. 기존 Outbox(보고 대기함)는 응답 본문을 버리지만, Planning은 응답(초안 revision, CP 번호)이 결과에 필요하기 때문이다. 대신 Outbox와 같은 약속을 지킨다.

- 멱등 키 형식은 `<operation>:<runnerId>:<uuid>`다. Outbox의 일반 보고 키와 같다.
- 보내기 **전에** 키와 본문을 진행 기록에 저장한다.
- 같은 job에서 같은 요청을 다시 보내면 저장한 키·본문을 그대로 쓴다.
  - 왜: 서버는 처리했는데 응답을 잃은 경우, 새 키로 보내면 같은 일을 두 번 한다. 같은 키에 다른 본문을 보내면 거부된다.
- 네트워크 오류·408·429·5xx는 Outbox와 같은 간격 규칙으로 최대 6번까지 보낸다.
- 단계 실패 메모는 비밀값을 가리고(`security/redact.ts`) 300자로 줄인다.

## 결과 코드

| 결과 | 코드 | 뜻 |
|---|---|---|
| failed | `PLANNING_STEP_FAILED` | 초기 분석·차이 분석의 한 단계가 실패했다. 실패 단계를 보고했다 |
| failed | `INVALID_RESUME_STEP` | Runner가 이어 할 수 없는 재개 단계다(예: 팀장 단계) |
| failed | `PLANNING_AGENT_FAILED` | Agent 호출이나 합의가 실패했다. 아무것도 보내지 않았다 |
| failed | `UNSUPPORTED_PAYLOAD` | 처리할 내용이 없는 payload다 |
| failed | `CHECKPOINT_UNREADABLE` | 진행 기록을 읽지 못했다 |
| failed | 서버 오류 코드 | 서버가 보고를 거부했다(예: `VERSION_CONFLICT`) |
| lost | `LEASE_LOST`·`EPOCH_MISMATCH`·`AUTHENTICATION_FAILED` | 더 보고하지 않는다 |

## 시험

```sh
pnpm -C agent-runner test -- planning
```

- 가짜 API는 Runner가 보낸 모든 요청 본문을 `agent-wbs/contracts/openapi.json`의 요청 스키마로 검사한다(`test/planning/schema.ts`).
- 가짜 Agent·작업 공간은 `test/planning/harness.ts`에 있다. 실제 Claude·Codex·GitHub를 부르지 않는다.

## 아직 연결하지 않은 것

- job 계층 연결(claim·start·renew·finish와 이 함수 호출)은 M5-05에서 한다.
- `PlanningWorkspace`의 실제 구현(Git 안전 계층 `src/git`과 GitHub 어댑터 `src/github` 묶기)은 아직 없다. 특히 `repo` 단계의 생성 커밋 push는 외부 쓰기 권한 확인(contracts §3.4-5)과 함께 붙여야 한다.
- `PlanningAgent`의 실제 구현(CLI 호출·출력 파싱)은 M5-01·M5-02 뒤에 붙인다.

## 용어

- orchestration: 여러 단계를 정해진 순서로 엮어 실행하는 것.
- 진행 기록(checkpoint): 다음 job에서 이어 하려고 이 PC에 저장한 단계 결과와 보낸 요청.
- 작성자(author): 합의안·초안·CP처럼 글 하나를 쓰는 Agent. 기본은 Claude다.
- 독립 판단: 두 Agent에게 따로 묻고 서로의 답을 보여 주지 않는 질문.
- 이견(disagreement): 두 Agent의 판단이 갈려 기록하지 않은 규칙.
