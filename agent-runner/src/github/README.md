# github — GitHub 어댑터

Runner가 GitHub(git 저장소를 올려 두고 PR·검사·병합을 하는 서비스)와 이야기하는 부분이다.
"어댑터"는 바깥 서비스의 API(프로그램끼리 주고받는 요청 규칙)를 우리 코드가 쓰기 쉬운 함수로 감싼 것을 말한다.
기준 문서: `docs/plan/contracts.md` §4.1(코드 근거 고정)·§6(GitHub 계약), `docs/plan/architecture.md`의 「GitHub 토큰 전달」.

> 지금은 **실제 GitHub를 부르지 않는다.** 시험 저장소가 정해지지 않았기 때문이다(open-questions Q-09).
> 모든 테스트는 `test/fakes/github/`의 가짜 GitHub(fake)를 상대로 돈다. 실제 확인은 M4-06에서 한다.

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `credential.ts` | 봉인된 토큰을 연다. 봉인 형식의 기준 구현도 여기 있다. |
| `token.ts` | 클라이언트에 토큰을 건네는 두 방식: 봉인 값(토큰 방식), `gh auth token`(gh 로그인 방식). |
| `client.ts` | 연결·저장소 확인, PR, commit status, PR 병합. |

## 1. 봉인 자격 증명

**봉인**이란 받는 사람의 공개키로 잠가, 그 사람의 개인키로만 열 수 있게 만든 값이다.
서버는 GitHub 토큰을 평문으로 보내지 않고 Runner 공개키로 봉인한 값(`GET /api/runner/github/credential`의 `sealed`)만 보낸다.
왜: 응답이 로그나 프록시에 남아도 토큰이 드러나지 않게 하기 위해서다(G §9.5-4-1).

- 형식(base64url 문자열): `버전(1바이트) | 임시 X25519 공개키(32) | nonce(12) | GCM tag(16) | 암호문`
  - 열쇠 = HKDF-SHA256(임시 키와 Runner 키로 만든 공유 비밀, salt = 임시 공개키 ‖ Runner 공개키, info = `agentwbs/github-credential/v1`)
  - 암호 = AES-256-GCM. 머리말(버전·임시 공개키)도 함께 인증하므로 한 글자만 바꿔도 열리지 않는다.
  - 예: 같은 토큰을 두 번 봉인해도 임시 키가 매번 달라 결과 문자열이 다르다.
- 연 값은 `Secret`(문자열 변환·JSON·로그에 `[REDACTED]`로만 보이는 상자)으로만 돌려준다.
- 실패하면 `CredentialError`. 메시지에 봉인 값이나 토큰을 넣지 않는다.

## 2. 토큰 공급원

- `sealedTokenSource(fetchSealed, privateKey)` — 서버에서 봉인 값을 받아 열고 메모리에 둔다. 401이나 교체 뒤에는 `invalidate()`로 비운다.
- `ghTokenSource()` — `gh auth token --hostname github.com`을 shell 없이 argv(명령과 인자를 배열로 따로 넘기는 방식)로 실행한다. 서버에는 비밀값이 없다.

## 3. 클라이언트 (`createGitHubClient`)

| 함수 | 하는 일 | 돌려주는 것 |
| --- | --- | --- |
| `checkConnection(mode)` | 계정·권한·만료 확인. 실패해도 던지지 않는다 | `reportGithubStatus` 본문 모양 |
| `checkRepository()` | 접근·private·main 커밋·필수 구조(G L233) | `reportRepoCheck` 본문(fence 제외) |
| `ensurePullRequest()` | `agent/<TASK>` → main PR. 이미 있으면 그것을 돌려준다 | PR + `created` |
| `getPullRequest()`·`closePullRequest()` | PR 조회·닫기 | |
| `setCommitStatus()`·`listCommitStatuses()` | `agentwbs/task·int·night·deploy` status 게시·조회 | |
| `mergePullRequest({pr, baseSha, headSha})` | **유일한 병합 경로** | `MergeOutcome` |

### 병합: strict + 예상 head 단일 경로

기호: A = 대기열이 고정한 main 커밋, H′ = ②(통합 확인)를 통과하고 `agentwbs/int`를 붙인 PR head.

1. 입력 검사(40자리 소문자 SHA, A≠H′) → `beforeWrite`(권한 세대 대조) → `PUT /pulls/{n}/merge`에 `sha=H′`, `merge_method=merge`.
2. 결과 해석
   - 200 → 병합 커밋의 부모가 정확히 `[A, H′]`이고 tree(커밋 시점의 파일 전체 내용)가 H′의 tree인지 확인 → `merged`. 다르면 `verify_failed`(done 금지, main 자동 되돌림 없음).
   - 409 → `head_changed`(QA 뒤 head가 바뀜). 405 → `rejected`(main 이동·필수 검사 미충족).
   - 통신 실패·5xx → **다시 병합하지 않고** PR을 조회해 대조한다 → `merged`/`verify_failed`(`reconciled: true`) 또는 `not_merged`. 조회도 실패하면 `unknown`.
   - 왜 다시 부르지 않나: 응답만 잃었을 뿐 병합이 이미 됐을 수 있기 때문이다(contracts §3.4-6).
3. main 직접 push, ref 갱신, squash/rebase 병합 함수는 만들지 않았다.

### 쓰기 차단과 비밀값

- 모든 쓰기(PR 생성·닫기, status, 병합) 직전에 `beforeWrite(operation)`을 부른다. 이것이 던지면 GitHub를 부르지 않는다.
  예: 서버가 `EXTERNAL_WRITE_BLOCKED`라고 하면 호출자가 여기서 막는다. 이것은 협조적 검사(상대가 규칙을 지킬 때만 통하는 검사)이고 최종 방어는 자격 증명 폐기다(contracts §3.4-5).
- 토큰은 `Authorization` 헤더에만 싣고 URL에는 넣지 않는다. 리다이렉트는 따라가지 않는다(토큰이 다른 주소로 가지 않게).
- 오류 메시지·status 설명의 비밀값은 가린다. status 설명은 가린 뒤 140자로 자른다.
- 오류의 `retryable`: 통신 실패(status 0)·5xx·429·속도 제한 403만 true. 재시도 대기열(outbox)은 이 모듈 밖(M4-01 쪽)이다.

## 확인 명령

```sh
pnpm -C agent-runner test -- github
```
