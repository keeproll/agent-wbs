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
- H1 조정자 결정: 관리자라는 역할 이름 대신 main의 실제 보호 규칙과 우회 권한을 확인한다.
  - `GET /rules/branches/main`으로 현재 main에 적용된 규칙을 읽는다.
  - PR·CODEOWNERS·`agentwbs/int`·strict·강제 push 및 삭제 금지가 모두 있어야 한다.
  - 해당 ruleset(보호 규칙 묶음)을 저장소 조회 API로 읽어 `enforcement: active`, `current_user_can_bypass: never`를 확인한다.
  - 하나라도 우회할 수 있거나 값을 확인하지 못하면 연결을 거부한다.
  - 이 조건을 만족하면 관리자 역할 계정의 fine-grained 토큰도 허용한다.
  - 왜: 막아야 하는 것은 보호 규칙의 우회이기 때문이다.

첫 실제 쓰기에서 바뀌는 규칙:

- 쓰기(PR 생성·닫기 → Pull requests, status 게시 → Commit statuses, 병합 → Contents)가 2xx면 그 권한은 **확인됨**.
- 속도 제한이 아닌 403이면 **부족**으로 바꾸고 `onPermissionDenied({permission, operation, message})`를 부른다. 호출자는 이것으로 팀장에게 알린다.
  응답에 `X-Accepted-GitHub-Permissions`가 있으면 그 헤더가 가리키는 권한을 부족으로 표시한다.
- 409·405·422·속도 제한 같은 다른 거부는 권한 증거가 아니므로 상태를 바꾸지 않는다.
- 알림 콜백은 기다리지 않는다. 동기 예외든 비동기(Promise) 실패든 삼키고, 원래 403 오류는 그대로 던진다. 알림 서버의 잠깐 장애로 Runner가 종료되지 않게 하기 위해서다.
### 권한 상태 갱신 규칙 (하나의 함수로 통일)

권한 상태를 바꾸는 곳은 `applyEvidence()` **한 곳뿐**이다. 실제 쓰기 결과도, 연결 확인 결과도 모두 「사건」으로 만들어 이 함수에 넘긴다.
이 함수는 `await`가 없는 동기 함수라서, 사건이 동시에 여러 개 생겨도 하나씩 차례로 반영된다(이것을 「직렬화」라고 한다).
`test/github/generation.test.ts`가 소스를 읽어 이 사실을 고정한다.

용어부터:

- **세대(generation)**: 연결 확인을 시작할 때, 그리고 요청에 쓰는 토큰이 바뀐 것을 관측할 때 1씩 오르는 번호. 요청마다 「보낼 때의 세대」를 기록한다.
- **사건 두 종류**
  - 실제 쓰기 결과: PR 생성·닫기, status 게시, 병합의 2xx(→ 확인됨) 또는 권한 부족 403(→ 부족).
  - 연결 확인 snapshot: 연결 확인이 계산한 네 권한의 판단.

규칙 세 가지:

1. **현재 세대가 아니면 버린다.** 옛 토큰으로 보낸 요청, 연결 재확인 전에 보낸 요청의 응답은 호출자에게는 그대로 돌아가지만 상태는 바꾸지 못한다. 버린 403은 알리지도 않는다.
2. **연결 확인은 가장 최근에 시작한 것만 반영한다.** 그 확인이 보낸 요청이 모두 현재 세대여야 한다. 아니면 결과에 `superseded: true`, `ok: false`가 붙는다.
   - 토큰을 아예 못 읽은 경우(예: gh 로그인 풀림)는 요청을 보내지 못했을 뿐 현재 실패다. 무효화가 아니라 그대로 반영한다(R12).
3. **우선순위: 실제 쓰기 결과 > 연결 확인 snapshot.**
   - 쓰기 증거마다 「그 요청을 보낸 세대」를 요청 시작 때 묶어 기억한다. snapshot은 **지금 세대에서 보낸** 쓰기 결과를 지우지 못한다(R13).
     연결 확인을 시작하면 새 세대가 열리므로, 지금 세대의 쓰기 = 「확인이 시작된 뒤 + 지금 토큰으로 보낸 쓰기」다.
   - 확인 도중 토큰이 바뀌면(예: 확인의 토큰 취득이 늦는 사이 다른 요청이 옛 토큰으로 쓰기를 하고, 확인은 새 토큰으로 끝남) 옛 토큰의 쓰기 결과는 다른 세대라 새 토큰에 이어지지 않는다(R14). 결과의 `ok`·이유·경고도 그에 맞춰 다시 맞춘다. 예: 확인 도중 status 쓰기가 403을 받으면 확인 결과도 `ok:false`, 「쓰기 권한 부족(실제 쓰기 403)」.
   - 연결 확인이 **시작되기 전의** 쓰기 결과는 새 판단으로 바뀐다. 예: 팀장이 토큰 권한을 고친 뒤 다시 확인하면 「부족」이 풀린다.

`test/github/permission-order.test.ts`는 연결 확인 시작, 쓰기 시작, 토큰 교체, 토큰 취득 실패 모드, 토큰 취득 완료(늦게 끝나는 취득 포함), 응답 도착을 무작위로 섞은 500가지 경우에서 위 규칙이 지켜지는지 검사한다. 실패하면 seed 번호로 같은 순서를 다시 돌릴 수 있다(`DBG=1`이면 사건 기록을 출력한다).

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

## 실제 시험 저장소 실증(M4-06)

실제 GitHub에 쓰는 명령은 일반 `test`와 분리했다.
이 실증에는 Node.js 26, `gh`, Git, OpenSSH의 `ssh-agent`·`ssh-add`, Python 3와 설치된 `cryptography` 모듈이 필요하다.
`cryptography`는 개인키 파일을 만들지 않고 시험용 키를 메모리에서 생성할 때만 쓴다.
운영 Runner의 SSH 공급 연결에는 이 Python 모듈이 필요하지 않다.
대상은 `keeproll/agent-wbs-sandbox` 하나로 고정했다.
다른 주소로 쓰려고 하면 실행 전에 거부한다.
왜: 개발 저장소의 코드나 설정을 시험 때문에 바꾸면 안 된다.

```sh
pnpm -C agent-runner test:github:real -- /home/keeproll/.orca/bots/agentwbs/archive/2026-11-26/M4-06/새-실행-폴더
```

새 실행 폴더를 지정해야 한다.
`api.ndjson`에는 요청별 HTTP 상태 번호와 응답을 남긴다.
HTTP는 프로그램끼리 요청과 응답을 주고받는 통신 규칙이다.
`results.json`에는 판정과 커밋 SHA(커밋을 가리키는 고유 번호)를 남긴다.
토큰을 포함한 인증 헤더는 기록하지 않는다.

이 명령은 `gh`의 현재 로그인으로 설정과 일반 API(프로그램 호출 창구)를 시험한다.
H1 조정자 결정에 따라 현재는 관리자 역할도 main의 보호가 활성이고 실제 우회가 불가능하면 연결을 허용한다.
이전 실증의 관리자 역할 거부 기록은 당시 코드의 결과다.
이 결과만으로 비관리자 계정의 Runner 준비 점검을 통과했다고 말하지 않는다.

보호 규칙을 두 묶음으로 나눈다.

- `agentwbs M4-06 main`: PR(pull request, 변경 병합 요청)과 `agentwbs/int` 검사 성공을 요구한다. 최신 main을 포함해야 한다. CODEOWNERS(경로별 검토 책임자 목록) 검토도 요구한다. 시스템용 deploy key(저장소 하나에 붙이는 SSH 인증 키)만 우회할 수 있다.
- `agentwbs M4-06 main integrity`: 강제 push와 main 삭제를 막는다. 우회 대상은 없다.

왜: 시스템 키가 PR 규칙을 우회하더라도 기록을 강제로 덮어쓰거나 main을 지우게 해서는 안 된다.
`DeployKey` 우회는 특정 키 하나를 고르는 방식이 아니다.
GitHub API의 `actor_id`는 `null`이다.
따라서 다른 deploy key가 이미 있으면 이 스크립트는 중단한다.
시스템 키는 `ssh-agent`라는 메모리 보관 프로세스에만 넣는다.
실증이 끝나면 GitHub에서 키를 삭제한다.
그 뒤 같은 키로 push가 거부되는지 확인하고 메모리 보관 프로세스도 종료한다.

GitHub는 키가 보낸 커밋이 최초 생성인지 초기화인지 판별하지 않는다.
Runner의 `pushSystemCommit()`은 부모 없는 최초 생성 커밋을 허용한다.
초기화 커밋은 예상 main 하나를 부모로 가져야 한다.
초기화 대상 세 경로 밖을 바꾸면 전송 전에 거부한다.
`RunnerApp`에서 초기화 실행기까지 시스템 SSH 설정을 연결했다.
일반 PR 병합에는 이 SSH 키를 쓰지 않는다.

시스템 키를 연결하려면 아래 공개 설정을 함께 넣는다.
개인키는 전용 `ssh-agent`에 미리 넣어 둔다.
`ssh-agent` 프로세스를 시작했다는 이유로 키가 들어 있는 것은 아니다.

```sh
AWBS_GITHUB_REPO=https://github.com/owner/repository
AWBS_SYSTEM_DEPLOY_KEY_ID=7
AWBS_SYSTEM_SSH_AUTH_SOCK=/run/user/1000/agentwbs-system.sock
AWBS_SYSTEM_SSH_KNOWN_HOSTS=/home/user/github-known-hosts
```

`AWBS_SYSTEM_DEPLOY_KEY_ID`는 GitHub가 발급한 키 번호다.
`AWBS_SYSTEM_SSH_AUTH_SOCK`는 메모리의 키로 인증을 요청할 소켓 경로다.
`AWBS_SYSTEM_SSH_KNOWN_HOSTS`는 신뢰할 GitHub 서버 키 목록이다.
서버 키 목록은 공개 정보다.
개인키 파일 경로를 받는 설정은 없다.

Runner는 연결 확인 전에 deploy key 목록을 조회한다.
일반 GitHub 쓰기와 시스템 커밋 전에도 다시 조회한다.
시스템 키 외 키가 하나라도 있으면 경고하고 GitHub 쓰기를 중단한다.
시스템 키가 읽기 전용이거나 목록을 읽지 못한 경우에도 중단한다.
다른 키 발견이나 권한 부족처럼 재시도할 수 없는 시작 실패는 Runner 실행을 종료한다.
통신 실패·5xx·속도 제한처럼 재시도 가능한 오류는 최대 세 번 조회한다.
서버가 준 대기 시간이 있으면 그 시간 이상 기다린다.
종료 신호가 오면 대기를 바로 끊고 남은 재시도와 시작 작업을 실행하지 않는다.
왜: GitHub가 긴 대기 시간을 주더라도 사용자의 종료 요청이 늦어지면 안 되기 때문이다.
세 번 모두 실패하면 경고를 남기고 Runner의 나머지 시작 절차는 계속한다.
이 경우에도 실제 GitHub 쓰기 직전 검사는 생략하지 않는다.
왜: 규칙을 우회할 다른 키가 있는데도 연결 성공으로 보고하면 안 된다.

목록 조회용 토큰에는 `Administration: read`가 추가로 필요하다.
기존 Contents·Pull requests·Commit statuses 권한만으로 이 목록을 조회할 수 있다고 가정하지 않는다.
이 읽기 권한은 저장소 설정을 바꾸는 쓰기 권한과 다르다.
근거는 [GitHub의 deploy key 목록 조회 문서](https://docs.github.com/en/rest/deploy-keys/deploy-keys#list-deploy-keys)다.

CODEOWNERS의 책임자와 PR 작성자가 모두 owner인 시험도 기록한다.
그 경우 병합 허용을 다른 작성자의 변경까지 허용한다는 증거로 쓰지 않는다.
다른 작성자가 보호 경로를 바꾼 PR의 거부는 별도 계정이나 앱으로 확인해야 한다.
owner 결정 10에 따라 다른 작성자·비관리자 검증은 팀원 합류 때로 미뤘다.
왜: 본인이 책임자인 경로를 본인이 바꾸는 경우와 다른 사람이 바꾸는 경우는 GitHub의 판단이 다르다.

### fine-grained 토큰과 폐기 확인

fine-grained 토큰은 저장소와 권한을 좁게 정하는 인증 비밀값이다.
owner가 이번 시험에만 쓰는 토큰 두 개를 발급해야 한다.
대상 저장소는 시험 저장소 하나만 고른다.

- 쓰기 토큰: Contents 읽기·쓰기, Pull requests 읽기·쓰기, Commit statuses 읽기·쓰기, Metadata 읽기.
- 읽기 토큰: Contents 읽기, Pull requests 읽기, Commit statuses 읽기, Metadata 읽기.

토큰을 채팅이나 명령 인자에 붙여 넣지 않는다.
owner의 실제 터미널에서 다음 명령을 실행한다.
입력 도우미는 입력을 화면에 표시하지 않는다.
입력을 숨길 수 없는 환경에서는 값을 받지 않고 중단한다.
출력이 터미널이면 입력 전에 중단한다.
토큰은 파이프(두 프로세스 사이의 메모리 통로)로만 넘긴다.

```sh
bash -o pipefail -c 'python3 agent-runner/scripts/github-token-input.py | node agent-runner/scripts/github.real.ts /home/keeproll/.orca/bots/agentwbs/archive/2026-11-26/M4-06/새-토큰-실행-폴더 --tokens'
```

`토큰 검사 종료` 메시지가 나온 뒤 GitHub 설정에서 이번 토큰 두 개를 삭제한다.
입력 도우미에 `폐기완료`를 입력한다.
스크립트는 두 토큰으로 `GET /user`가 401(인증 거부)인지 확인한다.
왜: 메모리에서 값을 지우는 것만으로는 이전 Runner가 가진 토큰을 막을 수 없다.
이 PC의 기존 `gh` 로그인 토큰은 폐기하지 않는다.

owner가 미룬 검증은 결과의 `deferred`에 남긴다.
토큰까지 검사하고 이번 토큰 두 개의 폐기 후 401을 확인하면 종료 번호는 0이다.
토큰 없이 실행하면 해당 검증이 남아 있으므로 종료 번호는 2다.
실증이나 정리가 실패하면 종료 번호는 1이다.
왜: 일부 항목만 통과한 실행을 M4-06 전체 완료로 보고하지 않기 위해서다.

### 정리와 실패 복구

정상 정리 순서는 기록한 PR 닫기, 기록한 Agent 브랜치 삭제, 되돌림 커밋 일반 push다.
되돌림은 `src/`, `contracts/`, `.agentwbs/`만 최초 시험 커밋의 내용으로 맞춘다.
`prototype/`과 CODEOWNERS는 현재 main의 내용을 보존한다.
되돌림 전에 main이 예상 SHA와 같은지도 확인한다.
왜: 시험 중 다른 사람이 올린 변경을 덮어쓰면 안 된다.

실패해도 같은 정리를 시도한다.
`cleanupFailure`나 `keyCleanupFailure`가 있으면 자동 정리가 끝난 것이 아니다.
`results.json`의 PR 번호, 브랜치 이름, deploy key 번호를 확인한다.
기록된 항목만 GitHub에서 닫거나 삭제한다.
사용자 변경이 섞인 main은 자동으로 되돌리지 않는다.
보호 ruleset은 실증 뒤에도 남긴다.
시험 저장소 전체를 없애는 일은 이 명령의 범위가 아니다.

### 용어 모음

- fake: 실제 GitHub 대신 테스트 안에서 같은 응답을 만드는 가짜 서버.
- head: PR 브랜치의 맨 끝 커밋.
- strict up-to-date: PR head가 최신 main을 포함해야 병합을 허용하는 규칙.
- status: 특정 커밋에 붙이는 검사 결과 표시.
- tree: 커밋 시점의 파일 전체 내용.
- SSH: Secure Shell. 키로 인증하는 보안 통신 방식.
- 소켓: 같은 PC의 프로세스끼리 요청을 주고받는 통로.
- 공개키: 공유할 수 있는 인증 키의 공개 부분.
- 개인키: 인증에 사용하는 비밀 부분.
- Administration: GitHub 저장소 관리 권한 이름. 여기서는 키 목록 확인을 위한 읽기만 요구한다.
- 응답 유실: GitHub는 요청을 처리했지만 호출자가 응답을 받지 못한 상황. 이 시험은 성공 응답을 받은 통신 경계에서 응답만 버려 재현한다.
- 405: 보호 규칙 미충족이나 병합 가능 여부 계산 중에 올 수 있는 병합 거절.
- 409: 계산이 끝난 PR에서 요청한 head SHA가 현재 head와 다를 때 오는 거절.
- 403: 이 시험에서는 권한 부족 때문에 요청이 거부된 상태. 속도 제한 403과 구분한다.
- 폐기: GitHub에서 자격 증명을 무효로 만들어 더 이상 인증하지 못하게 하는 것.

## 초기화 원격 정리(M4 통합)

`src/cleanup/remote.ts`가 contracts §6 순서를 지킨다.

1. 기록된 PR 닫기(`closePullRequest`). 이미 닫혔거나 없는 PR은 건너뛴다.
2. 기록된 원격 Agent 브랜치 삭제(`deleteBranch`, Contents 쓰기). 이미 없으면(404·422) 성공으로 본다.
3. 되돌림 커밋 일반 push.
   - main 직접 push는 **별도 시스템 커밋 자격 증명**으로만 한다(contracts §6, Q-09).
   - owner 결정 10에 따라 전용 deploy key의 메모리 키를 사용한다.
   - 시스템 키 설정이 없거나 다른 deploy key가 있으면 실패로 보고한다.
   - 보내기 전에 GitHub의 main이 되돌림 커밋의 부모와 같은지 확인한다.

로컬 저장소가 없으면 `topLevelEntries()`로 원격 main과 기준 커밋의 `src`·`contracts`·`.agentwbs`를 비교한다(쓰기 없음). 같으면 되돌림이 필요 없다.

GitHub가 401을 주면 앱이 토큰 캐시를 비운다. 다음 요청은 새 봉인 값을 받는다. 연결 재확인도 캐시를 비운다.

## 모든 외부 쓰기의 관문 — 마지막 확인 → 즉시 전송(M5·M7 통합)

Runner의 외부 쓰기는 Git push 두 가지(`pushCommit`, `pushSystemCommit`)와 REST 쓰기 다섯 가지(PR 생성·닫기, 브랜치 삭제, 상태 기록, 병합)다.
목록과 호출 위치는 `write-gate.ts`의 `REST_WRITES`·`GIT_WRITES`·`WRITE_CALLERS`에 있고, `test/external-writes.test.ts`가 소스와 대조한다.

관문은 두 단계다.

1. M4 쓰기 관문(`beforeWrite`): push면 원격이 설정 저장소인지 확인하고, 모든 쓰기에서 배포 키를 검사한다.
2. 소유 확인(작업이 있을 때): 중단 신호와 서버 임대 연장(fence·임대 대조, 남은 임대 ≥ 5초).

순서가 중요하다. 소유 확인은 **실제 전송 바로 앞**에서 하고, 그 뒤에는 다른 `await`가 없다.

- REST: 열린 PR 조회 → M4 관문 → 토큰 준비 → 소유 확인 → 중단 신호 확인(동기) → `fetch`. 소유 확인은 요청마다 다시 하고 결과를 캐시하지 않는다(`call`의 `write` 문맥).
- Git push: 저장소 신뢰 확인 → 소유 → M4 관문 → 소유 → 중단 신호 확인(동기) → `git push` 실행.
- 작업 문맥(소유 확인·중단 신호)은 공유 클라이언트를 바꾸지 않고 요청에 묶는다(`ownedGitHub`, `pushGate`). 여러 작업이 같은 클라이언트를 써도 섞이지 않는다.
- 중단 신호가 오면 진행 중인 요청(`fetch`)과 push(git 프로세스)도 끊는다.

왜 이렇게 하나: 메서드에 들어갈 때 한 번 확인하면, 그 안의 조회·키 검사·토큰 준비를 기다리는 사이에 중단되거나 임대를 잃어도 쓰기를 보낸다(Codex 재리뷰 재현 R1a~R1d).

실제로 보장하는 것과 보장하지 않는 것을 나누어 적는다(Codex 재리뷰 3 P3 정정).

보장하는 것:

- 요청마다 실제 전송 바로 앞에서 소유를 확인한다. 확인 뒤 다른 대기 없이 보낸다.
- 중단하면 진행 중인 전송을 끊는다. REST는 `fetch`를 끊고, Git push는 push의 프로세스 그룹 전체(git이 띄운 `git-remote-https`·`git send-pack` 포함)를 끝낸다.
  push는 자기 프로세스 그룹으로 띄우고, 중단하면 그룹에 TERM → 짧은 대기 → KILL을 보낸 뒤 **그룹이 비었음을 확인하고서야** 「중단됨」(`GitPushAbortedError`)을 알린다.
  비었음을 확인하지 못하면 「원격 상태 모름」(`GitPushUnknownError`)이다.
- 중단·모름 뒤 같은 브랜치에 다시 push하기 전에 원격 브랜치 head를 읽어 대조한다. 이미 그 커밋이면 다시 쓰지 않는다.

보장하지 않는 것(남는 분산 경계):

- 마지막 확인(서버 임대 연장 응답)과 GitHub의 실제 처리 사이에 임대가 끝나는 경우. 이 틈을 WBS 소유 확인으로 없앨 수는 없다.
- 중단 전에 이미 원격이 받아들인 쓰기는 되돌리지 않는다. 그래서 「중단됨」도 「원격 미변경」의 증거가 아니다. 복구할 때는 원격을 읽어 확인한다.

GitHub 쪽 조건은 소유 확인이 아니라 **추가 무결성 조건**이다. 각각 막는 범위가 좁다.

- 병합의 기대 head SHA(`sha`): PR head가 기대값과 다르면 409로 거부한다. 임대가 끝났어도 head가 그대로면 거부하지 않는다.
- PR 생성의 브랜치 기준 조회와 422 재조회: 같은 브랜치의 PR 중복을 막는다. 아직 PR이 없으면 낡은 작업의 최초 생성은 막지 못한다.
- 커밋 상태: 같은 커밋·context는 가장 늦게 도착한 값이 최신이 된다. 낡은 실행의 기록이 마지막에 오면 그 값이 남을 수 있다.
- 일반 push(강제 push 없음): 이력을 되감는 갱신을 막고, 브랜치 갱신은 원격에서 전부 또는 없음으로 반영된다. 임대가 끝난 작업의 정상적인 후속 커밋을 거부하지는 않는다.

시험: `write-race.test.ts`(병합 기대 head SHA 409, 같은 브랜치 PR 하나), `test/git/push-cancel.test.ts`(실제 HTTPS push 중단).

통신 실패(응답 유실)는 「보내지 않았다」가 아니다. 보냈는지 모른다.

- 병합: 쓰기 없이 다시 대조한다(`reconcileMerge`).
- PR 생성: 브랜치로 읽기 조회만 한다. 있으면 그 PR을 쓰고, 없으면 같은 관문으로 한 번 더 요청하고, 조회도 실패하면 「모름」(`PullRequestUnknownError`)으로 알린다.
- 소유 확인 실패·전송 전 중단은 보내지 않은 것이므로 대조 없이 그대로 오류다.
