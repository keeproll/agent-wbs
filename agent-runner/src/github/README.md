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
| `client.ts` | 연결·저장소 확인, PR, commit status, PR 병합과 병합 재대조. |

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
| `checkConnection(mode)` | 계정·권한(3상태)·만료 확인. 실패해도 던지지 않는다 | `ConnectionStatus` |
| `permissions()` | 지금까지 알게 된 권한 상태(연결 확인 + 실제 쓰기 결과) | 권한별 확인됨/미확인/부족 |
| `checkRepository()` | 접근·private·main 커밋·필수 구조(G L233) | `reportRepoCheck` 본문(fence 제외) |
| `ensurePullRequest()` | `agent/<TASK>` → main PR. 이미 있으면 그것을 돌려준다 | PR + `created` |
| `getPullRequest()`·`closePullRequest()` | PR 조회·닫기 | |
| `setCommitStatus()`·`listCommitStatuses()` | `agentwbs/task·int·night·deploy` status 게시·조회 | |
| `mergePullRequest({pr, baseSha, headSha})` | **유일한 병합 경로** | `MergeOutcome` |
| `reconcileMerge({pr, baseSha, headSha})` | `unknown` 병합을 쓰기 없이 다시 대조 | `MergeOutcome` |

### 병합: strict + 예상 head 단일 경로

기호: A = 대기열이 고정한 main 커밋, H′ = ②(통합 확인)를 통과하고 `agentwbs/int`를 붙인 PR head.

1. 입력 검사(40자리 소문자 SHA, A≠H′) → `beforeWrite`(권한 세대 대조) → `PUT /pulls/{n}/merge`에 `sha=H′`, `merge_method=merge`.
2. 결과 해석
   - 200 → 병합 커밋의 부모가 정확히 `[A, H′]`이고 tree(커밋 시점의 파일 전체 내용)가 H′의 tree인지 확인 → `merged`. 다르면 `verify_failed`(done 금지, main 자동 되돌림 없음).
   - 409 → `head_changed`(QA 뒤 head가 바뀜). 405 → `rejected`(main 이동·필수 검사 미충족).
   - 통신 실패·5xx → **다시 병합하지 않고** PR을 조회해 대조한다.
     - 병합이 보이면 `merged`/`verify_failed`(`reconciled: true`).
     - 병합이 안 보이면 `unknown`(`observed: 'open' | 'closed'`), 조회도 실패하면 `unknown`(`observed: 'read_failed'`).
   - 왜 다시 부르지 않나: 응답만 잃었을 뿐 병합이 이미 됐을 수 있기 때문이다(contracts §3.4-6).
   - 왜 「병합 안 됨」으로 확정하지 않나: 타임아웃은 GitHub 쪽 처리를 취소하지 않는다. 우리가 PR을 읽은 **뒤에** 원래 요청이 늦게 적용될 수 있다.
     예: 100ms 만에 포기하고 PR을 읽으면 열려 있지만, 잠시 뒤 같은 요청이 병합을 끝낸다(fake `holdMerges()`로 재현).
     그래서 결과 종류에 `not_merged`를 두지 않았다.
   - `unknown`을 받은 호출자는 그 병합을 다음 작업으로 넘기지 말고, 나중에 `reconcileMerge({pr, baseSha, headSha})`로 **쓰기 없이** 다시 대조한다.
     횟수나 시간이 찼다는 이유만으로 「효과 없음」을 확정하지 않는다. 언제 다음 작업을 허용할지는 §3.4 권한 계약(작업 대기열 쪽)이 정한다.
3. main 직접 push, ref 갱신, squash/rebase 병합 함수는 만들지 않았다.

### 쓰기 차단과 비밀값

- 모든 쓰기(PR 생성·닫기, status, 병합) 직전에 `beforeWrite(operation)`을 부른다. 이것이 던지면 GitHub를 부르지 않는다.
  예: 서버가 `EXTERNAL_WRITE_BLOCKED`라고 하면 호출자가 여기서 막는다. 이것은 협조적 검사(상대가 규칙을 지킬 때만 통하는 검사)이고 최종 방어는 자격 증명 폐기다(contracts §3.4-5).
- 토큰은 `Authorization` 헤더에만 싣고 URL에는 넣지 않는다. 리다이렉트는 따라가지 않는다(토큰이 다른 주소로 가지 않게).
- 오류 메시지·status 설명의 비밀값은 가린다. status 설명은 가린 뒤 140자로 자른다.
- 오류의 `retryable`: 통신 실패(status 0)·5xx·429·속도 제한 403만 true. 재시도 대기열(outbox)은 이 모듈 밖(M4-01 쪽)이다.
  - 속도 제한 403이란: `Retry-After`가 있거나(보조 제한), `x-ratelimit-remaining: 0`이거나(기본 제한), 본문이 rate limit을 말하는 403이다.
    그 밖의 403(권한 부족)은 기다려도 낫지 않으므로 재시도하지 않는다.
    근거: [Exceeding the rate limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit) — 보조 제한도 403 또는 429이며 `Retry-After`를 따르라고 한다.
  - `retryAfterSeconds`: `Retry-After`가 있으면 그 초. 없고 잔량이 0(기본 제한)이면 `x-ratelimit-reset`(UTC 초)까지 남은 초. 둘 다 아니면(보조 제한) 최소 60초.
    `x-ratelimit-reset`은 기본 제한이 풀리는 시각이라 보조 제한에 쓰면 너무 일찍 다시 부르게 된다. 반복될 때 대기를 늘리는 것은 outbox 몫이다.
  - 저장소 확인 중 속도 제한이면 「접근 불가」로 답하지 않고 재시도 오류를 던진다. 연결 확인은 던지지 않고 「속도 제한」 이유로 실패를 보고한다.

### status 목록과 페이지

- GitHub의 status 목록은 최신순이고 한 번에 최대 100개다([List commit statuses](https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28#list-commit-statuses-for-a-reference)). 한 SHA·context에 1000개까지 붙을 수 있어 100개를 넘는 것이 정상이다.
- 그래서 `page=1,2,3…`을 올려 끝까지 읽는다. 끝은 `Link` 헤더에 `rel="next"`가 없을 때다.
- `Link`에 적힌 주소로 직접 가지 않는다. 그 주소가 다른 서버를 가리키면 토큰이 새기 때문이다. 같은 API 경로에서 `page`만 바꾼다.
- 50페이지(5000개)를 넘으면 잘라서 돌려주지 않고 오류를 던진다. 조용히 일부만 돌려주면 대조가 틀리기 때문이다.

## 4. 필요한 권한과 확인 방법

원본 가이드 §9.5-4-1이 정한 네 권한이다. 각 권한이 왜 필요한지는 GitHub 공식 문서의 API별 요구 권한이 근거다.

| 권한 | 쓰는 곳 | 공식 근거 |
| --- | --- | --- |
| Contents 쓰기 | push, PR 병합 | [Merge a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request) |
| Pull requests 쓰기 | PR 생성·닫기 | [Create a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request) |
| Commit statuses 쓰기 | status 게시 | [Create a commit status](https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28#create-a-commit-status) |
| Metadata 읽기 | 저장소 조회 | [Get a repository](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#get-a-repository) |

권한마다 상태를 3가지로 낸다(조정자 결정 2026-11-26).

| 상태 | 뜻 | 실행 |
| --- | --- | --- |
| 확인됨(`verified`) | 읽기 응답·OAuth 범위·성공한 실제 쓰기로 확인했다 | 허용 |
| 미확인(`unverified`) | 확인할 방법이 없었다 | **허용하고 경고만 띄운다** |
| 부족(`missing`) | 범위에 없거나 실제 쓰기가 권한 부족 403을 받았다 | 연결 확인이면 실패, 쓰기 중이면 그 오류 |

연결 확인(`checkConnection`)이 판단하는 방법:

- 저장소를 읽었으면 Metadata 읽기는 **확인됨**이다.
- **classic 토큰·gh 로그인 토큰**: 응답 헤더 `x-oauth-scopes`에 `repo`가 있으면 쓰기 셋 모두 확인됨, 없으면 부족(연결 실패).
- **fine-grained 토큰**: 토큰에 실제로 준 권한 목록을 돌려주는 API가 없다.
  - 저장소 응답의 `permissions.push`는 **계정**의 권한이다. 계정이 push할 수 없으면 토큰도 못 쓰므로 쓰기 셋은 부족(연결 실패)이다.
  - 계정이 push할 수 있으면 쓰기 셋은 **미확인**이다. 연결은 성공(`ok:true`)으로 두고 `warning`으로 「쓰기 권한 미확인, 첫 쓰기에서 확인」을 알린다. 추정해서 확인됨으로 바꾸지 않는다.
  - 오류 응답의 `X-Accepted-GitHub-Permissions`는 그 API가 **요구하는** 권한일 뿐, 토큰이 가진 권한 목록이 아니다([문서](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#resource-not-accessible)).
- 관리자 계정이면 권한과 관계없이 `ok:false`다(contracts §4.1-3-7 「관리자가 아닌 별도 계정/앱」).

첫 실제 쓰기에서 바뀌는 규칙:

- 쓰기(PR 생성·닫기 → Pull requests, status 게시 → Commit statuses, 병합 → Contents)가 2xx면 그 권한은 **확인됨**.
- 속도 제한이 아닌 403이면 **부족**으로 바꾸고 `onPermissionDenied({permission, operation, message})`를 부른다. 호출자는 이것으로 팀장에게 알린다.
  응답에 `X-Accepted-GitHub-Permissions`가 있으면 그 헤더가 가리키는 권한을 부족으로 표시한다.
- 409·405·422·속도 제한 같은 다른 거부는 권한 증거가 아니므로 상태를 바꾸지 않는다.
- 알림 콜백은 기다리지 않는다. 동기 예외든 비동기(Promise) 실패든 삼키고, 원래 403 오류는 그대로 던진다. 알림 서버의 잠깐 장애로 Runner가 종료되지 않게 하기 위해서다.
- **늦은 응답은 상태를 바꾸지 못한다.** 연결을 다시 확인하거나 요청에 쓰는 토큰이 바뀌면 「권한 세대」를 올린다. 그 전에 보낸 요청의 응답은 호출자에게는 그대로 돌아가지만, 현재 권한 상태와 알림은 바꾸지 않는다.
  예: 옛 토큰으로 보낸 status 요청이 지연되는 동안 토큰을 바꾸고 새 토큰으로 쓰기에 성공했다면, 나중에 도착한 옛 403이 「부족」으로 덮지 않는다.
- 연결 확인도 같다. 판단은 따로 계산해 두고, **가장 최근에 시작한 확인이며 그 확인의 요청이 모두 현재 세대에서 보낸 것일 때만** 권한 상태에 반영한다.
  그렇지 않으면 결과에 `superseded: true`, `ok: false`를 붙여 돌려준다. 이 결과는 현재 연결의 상태가 아니므로 화면에 현재 상태로 보이면 안 된다.
  예: 옛 토큰의 연결 확인이 저장소 응답을 기다리는 동안 토큰을 바꾸고 다시 확인해 쓰기까지 성공했다면, 늦게 끝난 옛 확인은 「부족」을 되살리지 못한다(최종 리뷰 R11).
- 권한 상태를 바꾸는 곳은 실제 쓰기 결과(`observeWrite`, 첫 줄에서 세대 대조)와 연결 확인 반영(`commitPermissions`) 두 곳뿐이다. `test/github/generation.test.ts`가 소스를 읽어 이 목록을 고정한다.
- 연결 확인을 다시 하면 쓰기에서 얻은 결과를 지우고 새로 판단한다. 예: 팀장이 토큰 권한을 고친 뒤 「연결 확인」을 누르면 부족 표시가 풀린다.

**M4-06 실증 항목**(실제 GitHub에서만 확인할 수 있어 여기서는 확인하지 못한 것):

1. fine-grained 토큰의 실제 권한 목록. 쓰기 없이 확인할 방법이 있는지(있으면 미확인 대신 확인됨으로 바꿀 수 있다).
2. 권한이 빠진 토큰으로 PR 생성·status 게시·병합이 각각 403과 `X-Accepted-GitHub-Permissions`를 돌려주는지.
3. 보조 속도 제한 403의 실제 헤더 모양(`Retry-After` 유무).
4. 병합 PUT 타임아웃 뒤 실제로 늦게 적용되는 일이 있는지와 PR 조회 반영 지연. (어느 쪽이든 코드는 `unknown`으로 남긴다.)
5. 실효 보호 규칙(strict·int 필수·우회 불가 계정·CODEOWNERS). fake는 규칙이 있다고 가정할 뿐이다.

## 5. 봉인 키의 수명 (계약 보완안을 따름)

- Runner 개인키는 프로세스 메모리에만 둔다. 파일로 저장하지 않는다.
- Runner가 다시 시작하면 새 키 쌍을 만들어 등록하고 서버에서 새 봉인 값을 받는다. 예전 봉인 값이 새 키로 열리지 않는 것이 정상이다.
- 등록 형식은 X25519 공개키 SPKI PEM(`generateRunnerKeyPair().publicKey`)이다. 봉인 값 안의 임시 공개키는 PEM이 아니라 raw 32바이트다.
- 서버의 비밀값 암호화 키 `AWBS_SECRET_KEY`와 이 Runner 봉인 키는 전혀 다른 키다.
- 봉인은 「누가 보냈는지」나 「최신 값인지」를 증명하지 않는다. 그것은 Runner API 인증과 키 등록 계약이 맡는다. 이 형식은 RFC 9180 HPKE와 같은 형식이라고 부르지 않는다.
- 토큰 캐시: `invalidate()` 때마다 세대 번호를 올린다. 무효화 전에 시작한 조회가 늦게 끝나도 그 옛 토큰은 캐시하지도 돌려주지도 않고, 현재 세대로 다시 받는다. 같은 세대의 동시 호출은 조회 한 번을 함께 쓴다.
- 고정 시험 벡터 `test/github/fixtures/sealed-v1-vector.json`(리뷰의 Python 독립 구현이 만든 값)으로 바이트 배치를 고정했다. 서버 구현도 이 벡터를 통과해야 한다.
- 공개키 등록 API는 아직 계약에 없어 구현하지 않았다.

## 확인 명령

```sh
pnpm -C agent-runner test -- github
```
