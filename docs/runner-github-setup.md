# Runner 최초 등록과 GitHub 토큰 전달

이 안내는 Runner(서버 작업을 PC에서 실행하는 프로그램)를 처음 등록하는 owner(등록 책임 운영자)용이다.
기준 폴더는 `/home/keeproll/orca/workspaces/agent-wbs/gh-cred`다.
병합 뒤 다른 폴더에서 운영하면 아래 작업 폴더 경로를 그 폴더의 절대 경로로 바꾼다.
실제 GitHub에 쓰는 실증 명령은 이 안내에 없다.

## 준비

- 서버의 PostgreSQL(DB, 데이터를 보관하는 프로그램)이 실행 중이어야 한다.
- `agent-wbs/.env`의 `DATABASE_URL`이 운영할 DB를 가리켜야 한다.
- 같은 파일에 `AWBS_SECRET_KEY`가 있어야 한다.
- Node.js 26과 프로젝트 의존성이 설치되어 있어야 한다.
- 아래 Runner 홈은 `/home/keeproll/.agentwbs`다.

왜 이렇게 하나: 승인 명령은 서버와 같은 DB에 등록 기록을 남긴다.
`AWBS_SECRET_KEY`는 저장된 GitHub 토큰을 여는 암호 키다.
이 값을 잃으면 기존 GitHub 토큰을 다시 입력해야 한다.

## 1. Runner에서 공개키와 ID 만들기

사용 중인 Runner를 먼저 중지한다.
다음 명령은 Runner 상태 파일에서 Runner ID(실행기 식별자)를 읽는다.
처음 실행하면 상태 파일과 ID를 만든다.
같은 상태 파일을 다른 Runner가 사용 중이면 실행을 거부한다.

```bash
cd /home/keeproll/orca/workspaces/agent-wbs/gh-cred
install -d -m 700 /home/keeproll/.agentwbs
umask 077
set -o noclobber
AWBS_HOME=/home/keeproll/.agentwbs node agent-runner/scripts/runner-public-key.ts /home/keeproll/.agentwbs/runner.pub.pem > /home/keeproll/.agentwbs/runner.id
```

`runner.pub.pem`은 공개키 파일이다.
`runner.id`에는 Runner ID 한 줄만 들어간다.
공개키 파일이 이미 있으면 덮어쓰지 않는다.
최초 등록이 끝났다면 이 단계는 다시 실행하지 않는다.

왜 이렇게 하나: 임의로 지어낸 ID로 승인하면 실제 Runner의 요청이 403 `FORBIDDEN_PRINCIPAL`로 거부된다.
상태 파일의 ID와 승인할 ID가 같아야 한다.

이 명령은 X25519(키 교환 방식) 키 쌍을 만든다.
공개 부분만 파일로 내보낸다.
개인 부분은 명령이 끝날 때 버린다.
최초 공개키는 `runner_tokens.public_key`에 남기는 등록 기록이다.
Bearer 토큰(가진 사람이 Runner임을 증명하는 비밀 문자열)이 실제 서버 인증을 맡는다.
실행 중 GitHub 토큰을 봉인할 키는 시작할 때마다 새로 만든다.

왜 이렇게 하나: contracts §3.1은 봉인 키를 프로세스마다 새로 만들도록 정했다.
최초 등록을 위해 개인키를 파일에 남길 이유는 없다.

## 2. owner가 서버 CLI에서 승인하기

CLI(터미널에서 실행하는 명령)는 기존 `auth runner-token`을 쓴다.
별도 팀장 화면은 추가하지 않았다.
서버에 접근할 수 있는 owner가 공개키와 ID를 확인한 뒤 실행한다.

```bash
cd /home/keeproll/orca/workspaces/agent-wbs/gh-cred/agent-wbs/apps/api
read -r runner_id < /home/keeproll/.agentwbs/runner.id
umask 077
set -o noclobber
node --env-file-if-exists=../../.env --conditions=awbs-source src/platform/auth-cli.ts runner-token "$runner_id" /home/keeproll/.agentwbs/runner.pub.pem > /home/keeproll/.agentwbs/runner.token
chmod 600 /home/keeproll/.agentwbs/runner.token
```

성공하면 `runner.token`에 토큰 한 줄이 들어간다.
서버는 이 토큰의 SHA-256(내용을 고정 길이 지문으로 바꾸는 방식) 해시만 저장한다.
CLI는 X25519 SubjectPublicKeyInfo PEM(공개키를 담는 표준 텍스트 형식)을 검사한다.
다른 종류의 키와 개인키 파일은 거부한다.

왜 이렇게 하나: 공개키 파일 경로와 ID는 비밀이 아니다.
토큰은 화면이나 명령 인수에 넣지 않고 권한 `600` 파일에만 받는다.
이 파일은 소유자만 읽고 쓸 수 있다.

Runner가 다른 PC에 있다면 공개키와 ID만 서버 PC로 옮겨 승인한다.
발급된 토큰은 해당 Runner 운영자에게 안전한 경로로 전달한다.
토큰을 이슈·채팅·작업 보고에 붙이지 않는다.

## 3. 같은 Runner 홈으로 시작하기

서버가 실행 중이 아니면 먼저 시작한다.
서버는 `agent-wbs/.env`의 DB 주소와 암호 키를 읽는다.

```bash
cd /home/keeproll/orca/workspaces/agent-wbs/gh-cred
pnpm -C agent-wbs --filter @awbs/api dev
```

팀장 화면의 GitHub 설정에서 토큰 방식을 선택해 GitHub 토큰을 저장한다.
저장된 토큰이 없으면 봉인 조회는 404 `NOT_FOUND`다.
다른 터미널에서 Runner를 시작한다.
아래 공개 설정은 시험 저장소 `keeproll/agent-wbs-sandbox`를 지정한다.

```bash
cd /home/keeproll/orca/workspaces/agent-wbs/gh-cred
set +x
read -r AWBS_RUNNER_TOKEN < /home/keeproll/.agentwbs/runner.token
export AWBS_RUNNER_TOKEN
export AWBS_HOME=/home/keeproll/.agentwbs
export AWBS_URL=http://127.0.0.1:3100
export AWBS_GITHUB_REPO=https://github.com/keeproll/agent-wbs-sandbox
export AWBS_GITHUB_MODE=token
export AWBS_ATTEMPT_AUTO=0
export AWBS_CI_AUTO=0
pnpm -C agent-runner start
```

왜 이렇게 하나: 최초 등록 때 만든 상태 파일을 같은 홈에서 읽어야 승인된 Runner ID를 유지한다.
`set +x`는 셸의 명령 추적 출력을 끈다.
자동 시도 실행과 자동 CI(코드 검사 실행)를 켜는 승인은 이 작업의 범위 밖이다.

서버와 Runner의 GitHub 방식이 다르면 같은 방식으로 맞춘 뒤 다시 확인한다.
GitHub 토큰에는 `Contents`·`Pull requests`·`Commit statuses`의 쓰기 권한이 필요하다.
`Metadata` 읽기 권한도 필요하다.
deploy key(저장소 하나에 붙이는 SSH 인증 키) 목록 확인에는 `Administration: read`가 필요하다.
SSH는 키로 인증하는 보안 통신 방식이다.
왜 이렇게 하나: main 보호를 우회할 수 있는 다른 deploy key가 없는지도 확인해야 한다.

## 실행 중 자동 등록과 복구

1. Runner가 새 X25519 키 쌍을 메모리에 만든다.
2. `POST /api/runner/github/key`로 공개키를 등록한다.
3. 서버가 인증된 Runner와 `runnerId`가 같은지 확인한다.
4. 서버가 최신 PC·부팅 기록과 `hostId`·`bootId`가 같은지 확인한다.
5. 서버가 공개키의 SubjectPublicKeyInfo DER(표준 이진 형식)을 SHA-256으로 계산해 `keyId`를 돌려준다.
6. Runner가 `GET /api/runner/github/credential?keyId=`로 봉인 값을 받는다.
7. Runner가 자기 개인키로 봉인 값을 연다.
8. 실제 GitHub 연결 결과를 `POST /api/runner/github/status`로 보고한다.

왜 이렇게 하나: 다른 Runner의 공개키에 비밀 토큰을 봉인해 주면 안 된다.
서버 응답에는 평문 토큰이 없다.
봉인 응답에는 `Cache-Control: no-store`를 붙여 응답 보관을 막는다.

공개키 등록은 서버 메모리에만 남는다.
Runner 하나의 새 등록은 그 Runner의 이전 등록을 대체한다.
서버 재시작·PC 변경·재부팅·프로젝트 세대 변경 뒤 옛 등록으로 조회하면 404 `NOT_FOUND`다.
Runner는 404 뒤 새 `Idempotency-Key`로 등록하고 한 번 더 조회한다.
Idempotency-Key는 같은 요청의 중복 처리를 막는 이름표다.
같은 요청의 통신 재시도에는 같은 이름표를 쓴다.

왜 이렇게 하나: 옛 이름표로 다시 보내면 서버는 저장된 응답만 재생한다.
등록 코드는 다시 실행되지 않아 사라진 메모리 등록을 복구할 수 없다.

## 권한 3상태와 외부 쓰기 막힘

- `verified`: 실제 응답이나 성공한 쓰기로 확인했다.
- `unverified`: 아직 쓰기 권한을 확인하지 못했다.
- `missing`: 필요한 권한이 부족하다.

`unverified`는 경고를 함께 보고하면 실행을 허용한다.
`missing`이 있거나 연결 상태가 `failed`·`unchecked`이면 서버의 외부 쓰기 관문이 409 `EXTERNAL_WRITE_BLOCKED`로 거부한다.
연결 보고가 없거나 토큰 만료 시각이 지난 경우도 거부한다.
Runner 설정 화면도 외부 쓰기 막힘을 표시한다.
토큰을 고친 뒤 실제 재확인에 성공하면 GitHub 원인의 차단이 풀린다.
PC 변경에 따른 권한 세대(현재 PC의 외부 쓰기 허가를 구분하는 번호표) 차단은 기존 대조·승인 절차가 끝나야 풀린다.

왜 이렇게 하나: fine-grained 토큰(저장소와 권한을 좁힌 토큰)은 연결 확인만으로 쓰기 권한을 모두 알 수 없다.
첫 실제 쓰기가 권한 부족 403을 받으면 `missing`으로 보고해 후속 쓰기를 막는다.
봉인 값 수신 자체는 외부 쓰기 허가가 아니다.

main 보호 확인과 deploy key 점검은 기존 Runner GitHub 계층이 맡는다.
다른 deploy key가 있으면 읽기 전용 키라도 쓰기 전에 중단한다.
[M4-06 실증 규칙](../agent-runner/src/github/README.md#실제-시험-저장소-실증m4-06)은 그대로 적용한다.

## Runner 토큰 폐기하기

Runner를 중지한 뒤 서버 PC에서 실행한다.

```bash
cd /home/keeproll/orca/workspaces/agent-wbs/gh-cred/agent-wbs/apps/api
node --env-file-if-exists=../../.env --conditions=awbs-source src/platform/auth-cli.ts revoke-runner < /home/keeproll/.agentwbs/runner.token
rm /home/keeproll/.agentwbs/runner.token
```

왜 이렇게 하나: DB에서 폐기한 토큰은 봉인 조회를 포함한 Runner 요청에 더 이상 쓸 수 없다.
파일 삭제만으로 서버의 승인 기록이 폐기되지는 않는다.

## 용어집

- Runner: 서버 작업을 PC에서 실행하는 프로그램.
- owner: 서버 등록과 토큰 승인을 책임지는 운영자.
- DB: 데이터를 보관하는 프로그램.
- CLI: 터미널에서 실행하는 명령.
- ID: 대상을 구분하는 식별자.
- 공개키·개인키: 함께 만드는 두 키다. 공개키는 전달하고 개인키는 메모리에만 둔다.
- X25519: 두 쪽의 키로 같은 비밀을 만드는 키 교환 방식.
- SubjectPublicKeyInfo PEM / DER: 공개키의 표준 텍스트 / 이진 표현.
- SHA-256: 같은 내용을 같은 지문으로 바꾸는 해시 방식.
- Bearer 토큰: 가진 사람이 Runner임을 증명하는 비밀 문자열.
- 봉인 값(`sealed`): 공개키로 잠가 해당 개인키로만 열 수 있는 값.
- `keyId`: 공개키 지문으로 만든 등록 이름표.
- epoch: 프로젝트 초기화 전후를 구분하는 세대 번호.
- 권한 세대: 현재 PC의 외부 쓰기 허가를 구분하는 번호표.
- Idempotency-Key: 같은 요청의 중복 처리를 막는 이름표.
- fine-grained 토큰: 저장소와 권한을 좁혀 발급한 GitHub 토큰.
- deploy key: 저장소 하나에 붙이는 SSH 인증 키.
- SSH: 키로 인증하는 보안 통신 방식.
- CI: 코드 검사를 자동 실행하는 절차.

계약 근거는 [contracts §3.1·§6.1](plan/contracts.md)이다.
