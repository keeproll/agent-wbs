# 운영 설정 안내 (M8-06)

이 문서는 Agent WBS를 이 PC에서 「운영」으로 띄우고 지키는 방법을 설명한다.
처음 보는 사람도 순서대로 따라 할 수 있게 썼다.
owner가 지금 해야 할 일의 목록은 [실환경 기록](M8-06-real-env-record.md) 「owner가 할 일」에 따로 모았다.
용어는 처음 나올 때 풀어 쓰고, 끝의 「용어」와 [용어집](../glossary.md)에 모았다.

[README로 돌아가기](../README.md)

## 0. 한눈에 보기

운영 구성은 컨테이너(프로그램과 필요한 파일을 한 덩어리로 묶어 따로 돌리는 실행 단위) 다섯 개와 Runner 하나로 되어 있다.

```text
브라우저 ──▶ 127.0.0.1:5173 ──▶ [web: nginx] ──/api, /health──▶ [api] ──▶ [postgres]
                                     │ 화면 파일                                ▲
Runner(systemd 사용자 서비스) ──▶ 127.0.0.1:5173/api ─────────────────────────┘
                                                        [worker] ─────────────┘
                                                        [migrate] (시작할 때 한 번)
```

- 구성 파일: `agent-wbs/deploy/compose.prod.yaml`
- 이미지 설명서: `agent-wbs/deploy/Dockerfile`
- 스크립트: `agent-wbs/deploy/` 아래 `prod-init.sh`, `build.sh`, `set-image.sh`, `backup.sh`, `restore.sh`, `restore-rehearsal.sh`
- Runner 서비스: `agent-runner/deploy/awbs-runner.service.in`, `agent-runner/deploy/install-runner-service.sh`
- Runner 식별자 확인·공개키 파일: `pnpm -s -C <저장소>/agent-runner runner:public-key <공개키 파일>` (5.1.1, gh-cred 작업이 추가하는 명령)

명령은 모두 **bash**로, Runner 계정(사람 계정, 이 PC에서는 keeproll)으로 실행한다.
docker 명령은 언제나 `docker compose -p awbs-prod -f <저장소>/agent-wbs/deploy/compose.prod.yaml --env-file ~/.agentwbs/prod/deploy.env` 형태로 쓴다.
이 문서에서 「`… `」로 줄여 쓴 곳은 이 앞부분이다.

- 왜 `-p`·`-f`: 이 PC의 다른 컨테이너(개발용 `awbs`, `verum-*`)를 건드리지 않는다.
- 왜 `--env-file`: 쓸 이미지 꼬리표(`AWBS_IMAGE_TAG`)가 이 파일에 있다. 꼬리표가 없으면 compose가 바로 멈춘다(4장).

## 1. 구성 요소

### 1.1 postgres (DB)

- Debian 기반 `postgres:16` 이미지를 digest(이미지 내용의 지문)로 고정해서 쓴다.
  - 왜: alpine 이미지는 한글 정렬 결과가 달라 시험 DB와 순서가 어긋난다(개발 구성과 같은 이유).
- `track_commit_timestamp=on`으로 띄운다.
  - 왜: 보고서 상태 이력(M6-01)이 트랜잭션의 실제 커밋 시각을 쓴다. 이 설정은 서버 시작 때만 바꿀 수 있다.
- 호스트 포트를 열지 않는다.
  - 왜: 열지 않은 포트에는 다른 프로그램이 접속할 수 없다. 백업·점검은 `docker exec`로 컨테이너 안에서 한다.
- 헬스체크(컨테이너가 정상인지 주기적으로 묻는 검사)는 `pg_isready`다.

### 1.2 migrate (준비 단계)

- 시작할 때 한 번 돌고 끝난다.
- DB 마이그레이션(표 구조를 최신으로 바꾸는 작업)과 필수 기본 설정(seed system)을 넣는다.
- 여러 번 실행해도 결과가 같다. 그래서 업데이트할 때마다 자동으로 다시 돈다.
- api와 worker는 migrate가 성공해야만 시작한다.
  - 왜: 표 구조가 옛것인 채로 새 프로그램이 돌면 저장이 실패한다.

### 1.3 web (화면 + 전달)

- nginx(웹 서버 프로그램)가 빌드한 화면 파일을 보내 준다.
- `/api/…`, `/health`, `/health/db` 요청은 api로 그대로 넘긴다.
- 호스트의 `127.0.0.1:5173`에만 연다. 다른 PC에서는 접속할 수 없다.
- 헬스체크는 `/health/db`를 nginx → api → DB까지 한 번에 확인한다.

### 1.4 api

- REST API(화면과 Runner가 부르는 서버 창구)와 Telegram 즉시 알림을 맡는다.
  - Telegram은 Q-16 A 결정대로 상태가 바뀐 트랜잭션이 커밋되면 바로 보낸다.
  - Telegram 발송 반복 처리는 api 프로세스(`apps/api/src/main.ts`의 `startNotifyWorker`)에서 돈다. worker는 Telegram을 보내지 않는다.
- DB에는 관리자가 아니라 앱 전용 로그인 `awbs_app_login`으로 접속한다(3장 「DB 로그인 두 개」).
- api는 web 컨테이너의 네트워크 공간을 같이 쓰고, 그 안의 `127.0.0.1:3100`에서만 듣는다.
  - 왜: api에게는 모든 요청이 같은 PC 안(loopback)에서 온 것으로 보인다. 그래서 개발 때와 같은 보안 규칙(1회용 로그인 링크, Origin 검사)을 그대로 쓴다.
  - 예: api를 `0.0.0.0`에서 듣게 하면 LAN 공개로 판단해 LAN 비밀번호가 반드시 필요해진다.
- `AWBS_ORIGIN`은 `http://127.0.0.1:5173`이다. 화면 포트를 바꾸면 함께 바뀐다(compose가 자동으로 맞춘다).
  - Origin(브라우저 주소의 「프로토콜·호스트·포트」 묶음)이 다르면 변경 요청이 `FORBIDDEN_PRINCIPAL`로 거부된다.
- PDF 내려받기를 위해 Chromium(PDF를 만드는 브라우저 엔진)이 이미지에 들어 있다.

### 1.5 worker

- Runner 생존 감시, 보고서 정기 생성·누락 보충, 메일 발송, 초기화 파일 삭제를 맡는다(`apps/api/src/runner/worker.ts`).
- 메일 첨부 PDF도 worker가 만든다.
- 듣는 포트가 없어서 HTTP 헬스체크를 두지 않았다.
  - 대신 `docker compose … logs worker`와 화면의 알림으로 상태를 본다.

- worker도 api와 같은 앱 전용 로그인 `awbs_app_login`으로 접속한다.

### 1.6 Runner

- 컨테이너가 아니라 Runner 계정의 **systemd 사용자 서비스**(로그인한 사용자 몫으로 systemd가 띄우고 관리하는 프로그램)로 돈다.
  - 왜: Runner는 이 PC의 git 작업 폴더·CLI·docker를 직접 다룬다. 컨테이너 안에서는 이것들을 안전하게 다룰 수 없다(architecture §6.3).
- Agent는 전용 계정 `awbs-agent`로 실행한다(Q-08 B). 서비스 파일이 `AWBS_AGENT_USER=awbs-agent`를 고정한다.
- 자세한 내용은 5장.

## 2. 이름 · 포트 · 폴더

- compose project: `awbs-prod`
- 컨테이너: `awbs-prod-postgres`, `awbs-prod-migrate`, `awbs-prod-web`, `awbs-prod-api`, `awbs-prod-worker`
- 볼륨(컨테이너를 지워도 남는 데이터 저장소)
  - `awbs-prod-pgdata`: DB 파일
  - `awbs-prod-data`: 데이터 파일(evidence·PDF). 컨테이너 안 경로는 `/home/node/.agentwbs/wbs`다.
- 네트워크: `awbs-prod-net`
- 화면·API 주소: `http://127.0.0.1:5173` (Runner의 `AWBS_URL`도 이 주소)
- 비밀 파일·백업 폴더: `~/.agentwbs/prod/` (`secrets/`, `backups/`)
- 이미지: `awbs-app:<꼬리표>`, `awbs-web:<꼬리표>`. 꼬리표 기본값은 `local`이다.

개발 구성(`agent-wbs/compose.yaml`, project `awbs`)과 이름·볼륨·네트워크·DB가 모두 다르다.
왜: 개발 시험이 운영 데이터를 지우거나, 운영 백업에 개발 데이터가 섞이지 않게 한다.

포트 5173은 개발용 화면(vite)과 같다.
그래서 운영과 개발을 동시에 띄우려면 둘 중 하나의 포트를 바꾼다.

- 운영 쪽을 바꿀 때: 명령 앞에 `AWBS_WEB_PORT=5273`처럼 붙인다. Runner의 `AWBS_URL`과 화면의 「접속 주소」도 같이 바꾼다.
- 개발 쪽을 바꿀 때: `agent-wbs/.env`의 `AWBS_WEB_PORT`를 바꾼다.

## 3. 비밀값 규칙

### 3.1 비밀 파일

- 비밀값은 **파일**로 넘긴다. 이미지·저장소·compose 파일에는 넣지 않는다.
- 운영 비밀 파일은 세 개이고, `prod-init.sh`가 처음 한 번 만든다. 권한은 0600(만든 사람만 읽고 쓰기)이다.
  - `~/.agentwbs/prod/secrets/db-password`: DB **관리자**(`awbs_owner`) 비밀번호. postgres와 migrate만 쓴다.
  - `~/.agentwbs/prod/secrets/db-app-password`: **앱 전용 로그인**(`awbs_app_login`) 비밀번호. api·worker가 쓴다.
  - `~/.agentwbs/prod/secrets/secret-key`: DB에 SMTP 비밀번호·Telegram 토큰·GitHub 토큰을 암호화해 넣을 때 쓰는 키(`AWBS_SECRET_KEY`). api·worker가 쓴다.
- compose는 필요한 파일만 각 컨테이너의 `/run/secrets/`에 붙인다.
  - postgres: `db-password`
  - migrate: `db-password`, `db-app-password`
  - api·worker: `db-app-password`, `secret-key` (관리자 비밀은 붙이지 않는다)
- app 이미지의 진입점(`deploy/app-entrypoint.sh`)이 파일을 읽어, 실행할 프로그램 하나의 환경 변수(`DATABASE_URL`, `AWBS_SECRET_KEY`)로 넘긴다.
  - 정확히 말하면: 비밀값은 이미지·compose 파일·`docker inspect` 구성 정보에는 없다. 하지만 **실행 중인 api·worker 프로그램의 환경에는 있다.** 그 프로그램이 DB에 접속하고 토큰을 풀려면 값이 필요하기 때문이다.
  - 그래서 컨테이너 안에 들어갈 수 있는 사람(docker 그룹)은 그 값을 볼 수 있다. docker 그룹은 owner 계정만 둔다.
- 개발용 비밀(`~/.agentwbs/wbs/dev-db-password`, `~/.agentwbs/wbs/secret-key`)과 운영 비밀은 일부러 다른 값이다.
  - 왜: 개발 쪽이 새도 운영 데이터는 열리지 않는다.
- 컨테이너 안의 앱은 uid 1000(`node`) 계정으로 돈다. 비밀 파일 주인도 uid 1000이어야 읽을 수 있다.
  - 이 PC의 keeproll은 uid 1000이라 그대로 맞는다. 다른 PC로 옮기면 `id -u`로 먼저 확인한다.
- Runner 토큰(`AWBS_RUNNER_TOKEN`)은 `agent-runner/.env`(권한 0600)에만 둔다. 서비스 파일에는 넣지 않는다.

### 3.2 secret-key 따로 보관하기

- `secret-key`는 백업과 **다른 곳**에 파일째로 한 번 복사해 둔다.
  - 왜: 이 키를 잃으면 백업을 복원해도 암호화한 토큰을 열 수 없다. 반대로 백업 파일에 키를 함께 넣으면 백업 하나가 새는 순간 토큰까지 열린다.
- **값을 터미널에 출력하지 않는다**(`cat`으로 보지 않는다).
  - 왜: 터미널 기록·세션 녹화에 남는다. `clear`는 이미 남은 기록을 지우지 못한다.
- 방법 예시(하나 고른다)
  - 암호 관리자의 「파일 첨부·가져오기」로 `~/.agentwbs/prod/secrets/secret-key` 파일을 그대로 올린다.
  - USB 같은 다른 저장 장치에 파일째로 복사한다: `install -m 0600 ~/.agentwbs/prod/secrets/secret-key /media/<장치>/awbs-secret-key`
- 비밀값이 보이는 화면·출력은 보고나 메시지에 보내지 않는다.

### 3.3 DB 로그인 두 개

- 관리자 로그인 `awbs_owner`(superuser, DB의 모든 제한을 넘을 수 있는 관리자)
  - 마이그레이션, 필수 기본 설정 넣기, 앱 로그인 준비, 백업·복원에만 쓴다.
- 앱 로그인 `awbs_app_login`
  - `awbs_app`(앱이 쓰는 권한을 모은 역할)의 권한을 물려받기만 한다. `SET ROLE`로 다른 역할이 될 수 없다.
  - 그래서 보고서 이력(`state_log`·`global_log`·`commit_log`·`commit_real`)을 지우거나 비울 수 없고, 보호 트리거도 끌 수 없다.
  - 왜: 앱이 관리자 권한을 가지면 앱의 잘못된 SQL이나 침입이 DB 제약과 이력 보호 장치까지 끌 수 있다(data-model §6.1).
  - 관리자로 접속한 뒤 `SET ROLE`로 낮추는 방식은 쓰지 않는다. 같은 연결에서 `RESET ROLE`로 되돌릴 수 있기 때문이다.
- migrate가 시작할 때마다 앱 로그인을 맞춘다(없으면 만들고, 비밀번호를 `db-app-password`와 같게 하고, `awbs_app` 말고 다른 역할을 물려받고 있으면 회수한다).
- 확인 명령: `… exec -T api awbs-entrypoint db-check`
  - `"currentUser":"awbs_app_login","superuser":false`이고 `historyWritable`이 `[]`, 나머지 `…Blocked`가 모두 `true`면 정상이다.

### 3.4 이미 설치한 운영 구성에서 넘어오기

지금(2026-11-28) 이 PC에는 운영 구성이 아직 없다. 나중에 예전 구성(관리자 비밀 하나)으로 띄운 운영이 있다면 아래 순서로 넘어온다.

1. 백업한다(7.1).
2. `bash <저장소>/agent-wbs/deploy/prod-init.sh`를 다시 실행한다. 있는 파일은 그대로 두고 `db-app-password`만 새로 만든다.
3. 새 이미지를 만들고 꼬리표를 정한다(4.2의 2~3번).
4. `… up -d --wait`를 실행한다. migrate가 앱 로그인을 만들고, api·worker가 새 로그인으로 다시 뜬다.
5. `… exec -T api awbs-entrypoint db-check`로 확인한다.

## 4. 처음 설치와 업데이트

아래 예시는 저장소를 `/home/keeproll/projects/agent-wbs`에 둔 경우다.
실제 순서와 체크 칸은 [실환경 기록](M8-06-real-env-record.md) 「owner가 할 일」을 따른다.

### 4.1 처음 설치

1. 비밀 파일 만들기: `bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/prod-init.sh`
2. 이미지 빌드: `bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/build.sh` → 마지막 줄이 꼬리표(지금 커밋의 짧은 해시)다.
3. 꼬리표 정하기: `bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/set-image.sh <꼬리표>` → `~/.agentwbs/prod/deploy.env`에 적힌다.
4. 기동: `… up -d --wait`
5. 로그인 링크 받기: `… exec -T api awbs-entrypoint auth login-link` → 나온 주소를 브라우저로 연다(1회용).
6. 화면에서 프로젝트를 등록하고 설정을 넣는다(6장의 SMTP·Telegram 포함).
7. Runner 토큰을 발급하고 Runner 서비스를 설치한다(5장).

이미지 규칙과 이유

- 이미지 꼬리표는 커밋 해시다. 왜: 되돌릴 때 「어느 커밋으로 만든 이미지인지」를 바로 알 수 있다.
- `build.sh`는 커밋하지 않은 변경이 있으면 멈춘다. 왜: 꼬리표와 실제 코드가 달라지면 안 된다.
- compose 파일에는 이미지를 만드는 항목(`build`)이 없고, 없는 이미지를 받아 오지도 않는다(`pull_policy: never`).
  - 왜: 복원·되돌리기 때 「그때 쓰던 이미지」 대신 지금 소스로 새 이미지를 몰래 만들면 DB와 프로그램 버전이 어긋난다.
  - 꼬리표의 이미지가 없으면 기동이 멈춘다. 그때는 그 커밋으로 `build.sh`를 실행해 준비한다.

### 4.2 업데이트 배포

1. **백업**한다: `bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/backup.sh`
   - 왜: 배포 전 `pg_dump` 백업은 정해진 규칙이다(architecture §6.3).
2. 새 커밋으로 빌드한다(4.1의 2번, 새 꼬리표).
3. 새 꼬리표로 정한다(4.1의 3번).
4. `… up -d --wait`를 실행한다. migrate가 먼저 돌고, 성공하면 api·worker가 새 이미지로 바뀐다.
5. 화면 접속과 `curl -fsS http://127.0.0.1:5173/health/db`로 확인한다.
6. 서버 계약(API 요청·응답 모양)이 바뀐 배포라면 4.4를 먼저 본다.

무중단 교체는 하지 않는다. 몇 초에서 몇십 초 동안 화면이 응답하지 않을 수 있다.

### 4.3 되돌리기

- 앞 커밋의 꼬리표로 `set-image.sh`를 실행하고 `… up -d --wait`를 다시 실행한다. 그 이미지가 지워졌으면 그 커밋을 체크아웃해 `build.sh`로 다시 만든다(architecture §6.3, §4.13 L489).
- 마이그레이션은 앞으로만 간다. 새 버전이 표 구조를 바꿨다면 옛 이미지가 새 구조에서 돌지 못할 수 있다.
  - 그때는 배포 직전 백업을 7.2의 방법으로 복원한다.

### 4.4 서버 계약을 바꾸는 배포 (옛 job 처리)

「서버 계약을 바꾸는 배포」는 Runner가 받는 일(job)의 입력 모양이나 보고 모양이 바뀌는 배포다.
대기 중인 옛 job(`input_diff`·`split`·`estimate`·`planning`)의 입력을 새 코드가 해석하지 못할 수 있다.
아래는 지금 코드(2026-11-28)로 확인한 사실이다.

1. **새 일 수령을 언제 멈추나**
   - 서버에는 「수령 일시 중지」 설정이 없다.
   - 지원하는 방법은 Runner를 멈추는 것뿐이다: `systemctl --user stop awbs-runner.service`. Runner가 없으면 아무도 일을 가져가지 않는다.
2. **이미 실행 중인 일은**
   - Runner가 멈추면 서버는 임대(60초)나 생존 보고가 끊긴 일을 worker의 감시(`apps/api/src/runner/watch.ts`)로 정리한다.
   - `split`·`estimate`·`planning`은 `cancelled`(코드 `LEASE_LOST`)가 된다.
   - `input_diff`·`bootstrap`은 바로 지우지 않고 `reconcile`(실제 결과 대조 대기)이 된다.
   - 실행 중인 일이 있는지는 화면 「Runner · 실행 환경」과 `GET /api/runner-state`의 보유 목록으로 본다. 끝날 때까지 기다린 뒤 Runner를 멈추는 것을 권한다.
3. **옛 일의 임대와 fence(낡은 Runner의 보고를 막는 번호표)는**
   - 서버는 일을 다시 내줄 때마다 fence를 1 올린다. 옛 fence나 끝난 임대로 온 보고는 `LEASE_LOST`로 거부한다(`apps/api/src/runner/service.ts`).
   - 그래서 이미 정리된 일의 늦은 보고는 따로 무효화하지 않아도 거부된다.
   - 하지만 **아직 아무도 가져가지 않은 `queued` 일**은 그대로 남는다. 새 Runner가 그 옛 입력을 그대로 가져간다.
4. **어떤 일을 어떤 지원 API·CLI로 다시 만드나**
   - `queued` 일을 취소하거나 새 입력으로 다시 만드는 API·CLI는 **없다.**
   - 끝난(실패·취소) 일을 다시 요청하는 화면 기능은 일부 있다: 입력 차이 분석 「다시 시도」(`POST /api/project/inputs/retry`), 초기 분석 「다시 시도」(`POST /api/project/bootstrap/retry`), 분할 요청(`POST /api/tasks/{taskKey}/split`), Planning 시작(`POST /api/plannings`).
   - 그런데 분할 요청은 같은 내용의 열린 일이 있으면 그 옛 일을 돌려준다(`apps/api/src/planning/split.ts`). 그래서 `queued` 옛 일을 바꿔 주지 못한다.
5. **중복이 없고 옛 보고가 거절되는지 어떻게 확인하나**
   - 중복 방지는 `runner_jobs.dedup_key` 고유 제약이 맡는다. 옛 보고 거절은 위 3번의 fence 검사가 맡는다.
   - 대기 중인 일을 종류별로 보여 주는 지원 명령은 **없다.**

결론

- 지금은 서버 계약을 바꾸는 배포를 안전하게 할 지원 명령이 없다. **그런 배포는 아래 최소 명령을 만든 뒤에 한다.**
- 임의의 SQL로 일의 상태나 fence를 바꾸지 않는다. 왜: 상태 전이 검사와 이력 기록을 건너뛰어 다른 불일치를 만든다.
- 계약이 바뀌지 않는 배포(화면·문서·내부 수정)는 4.2대로 해도 된다.

제안하는 최소 명령(아직 만들지 않음, owner 결정 필요 — 실환경 기록 2장 F-6)

- `awbs-entrypoint jobs open` — 읽기 전용. `queued`·`leased`·`started`·`reconcile` 일을 종류·만든 시각·fence와 함께 보여 준다.
- `awbs-entrypoint jobs reissue --kinds input_diff,split,estimate,planning --reason contract-change`
  - 한 일마다 한 트랜잭션에서: `queued` 일만 고른다 → `cancelled`(코드 `CONTRACT_CHANGED`)로 바꾸고 fence를 1 올린다 → 그 일을 처음 만든 서버 함수로 지금 DB에서 입력을 다시 만들어 새 일을 넣는다(dedup_key 순번 +1) → 이력에 남긴다.
  - Runner가 멈춘 상태에서만 실행한다(열린 세션이 있으면 거부).
- 그때의 배포 순서: Runner 멈춤 → 백업 → 새 이미지 기동 → `jobs reissue` → `jobs open`으로 확인 → Runner 시작.

## 5. Runner 서비스 (systemd 사용자 서비스)

### 5.1 미리 갖출 것

- **linger**(로그아웃하거나 PC를 다시 켠 뒤에도 그 계정의 사용자 systemd를 띄워 두는 설정)가 켜져 있어야 한다.
  - 확인: `loginctl show-user keeproll -p Linger` → `Linger=yes`
  - 왜: 꺼져 있으면 재시작 뒤 아무도 로그인하지 않았을 때 Runner와 세션 scope가 뜨지 않는다.
  - 켜기(관리자 권한, owner가 실행): `sudo loginctl enable-linger keeproll`
- Agent 전용 계정과 실행 래퍼가 설치돼 있어야 한다(`agent-runner/docs/OWNER-RUNBOOK.md` 1~6단계).
- `agent-runner/.env`(권한 0600)에 다음이 있어야 한다.
  - `AWBS_URL=http://127.0.0.1:5173`
  - `AWBS_RUNNER_TOKEN=<운영 서버에서 발급한 토큰>` (5.1.1)
  - `AWBS_AGENT_USER=awbs-agent` (없어도 서비스 파일이 고정하지만, 다른 값이면 설치를 거부한다)
- 기존 `.env`에 이미 있는 값도 확인한다(값이 비밀이 아닌 줄만 본다).
  - `AWBS_GITHUB_MODE`: 지금 운영 검증 범위는 **`gh`**(이 PC의 `gh` 로그인을 쓰는 방식)다. 줄이 없으면 기본값 `gh`다. `token`이면 `gh`로 바꾼다.
    - 왜: `token` 방식은 서버의 GitHub 봉인 처리기(`POST /api/runner/github/key`, `GET /api/runner/github/credential`)가 있어야 동작한다. 계약과 Runner 쪽 호출 코드는 있지만 서버 처리기는 아직 없다(다른 작업 gh-cred에서 구현 중). **token 방식은 gh-cred 병합 후**에 쓴다.
  - `AWBS_ATTEMPT_AUTO`, `AWBS_CI_AUTO`: 줄이 없거나 `0`이면 꺼짐이다. `1`이면 실제 Claude·Codex 호출과 CI 실행이 시작된다. 켜는 것은 owner가 정할 때만 한다(OWNER-RUNBOOK 7단계).
  - 확인 명령(비밀값 줄은 보이지 않는다): `grep -E '^(AWBS_URL|AWBS_AGENT_USER|AWBS_GITHUB_MODE|AWBS_GITHUB_REPO|AWBS_ATTEMPT_AUTO|AWBS_CI_AUTO)=' <저장소>/agent-runner/.env`

#### 5.1.1 Runner 토큰 발급 — 반드시 그 Runner의 ID로

- Runner는 처음 시작할 때 자기 식별자(`runnerId`, 무작위 UUID)를 만들어 `AWBS_HOME/state/runner.json`에 저장한다.
- Runner 토큰은 이 식별자 하나에 묶인다. 다른 이름(예: `runner-main`)으로 발급한 토큰으로는 서버가 `403 FORBIDDEN_PRINCIPAL`로 거부한다.
- 그래서 순서는 이렇다. **이 순서는 gh-cred 작업이 병합된 뒤에 쓴다**(`runner:public-key` 명령을 그 작업이 추가한다).
  1. Runner를 멈춘다(켜져 있다면): `systemctl --user stop awbs-runner.service`
  2. 공개키 파일 만들기와 식별자 확인: `pnpm -s -C <저장소>/agent-runner runner:public-key <아직 없는 공개키 파일의 절대 경로>` → 출력 한 줄이 식별자다.
     - 상태 파일의 실제 식별자를 쓴다. 상태 파일이 없으면 Runner가 처음 시작할 때와 같은 방법으로 만든다.
     - 공개키 파일을 새로 만든다(있으면 덮어쓰지 않고 실패한다). 개인키는 파일로 남기지 않는다.
     - Runner가 켜져 있으면 데이터 폴더 잠금 때문에 실패한다.
  3. 그 식별자로 토큰 발급: `… exec -T api awbs-entrypoint auth runner-token <식별자> /dev/stdin < <공개키 파일>`
     - 왜 Runner 쪽 명령을 쓰나: 식별자를 사람이 지어 넣으면(예: `runner-main`) 실제 Runner의 식별자와 달라 403이 된다.
- 키 두 종류를 헷갈리지 않는다.
  - **토큰 발급 때 넣는 공개키**: `auth runner-token`이 요구하는 X25519 공개키 파일이다. 「이 Runner를 승인한다」는 기록으로 저장된다. 서버 인증은 Bearer 토큰이 맡는다.
  - **GitHub 봉인용 키**: Runner가 실행 중에 새로 만들어 `POST /api/runner/github/key`로 등록하는 키다. 서버가 GitHub 토큰을 이 키로 잠가(봉인) 보낸다(`token` 방식).
  - main `1ce62aa` 기준으로는 봉인 처리기가 없다. 그래서 지금 검증 범위는 `gh` 방식이고, **token 방식은 gh-cred 병합 후**에 쓴다. 자세한 것은 gh-cred가 추가하는 `docs/runner-github-setup.md`를 따른다.

### 5.2 설치 스크립트가 하는 일

`install-runner-service.sh`는 먼저 아래를 점검한다. 하나라도 틀리면 설치하지 않는다.

1. linger가 켜져 있는가
2. `awbs-agent` 계정과 root 소유 실행 래퍼(`/usr/local/libexec/awbs-agent-exec`)가 있는가
3. `agent-runner/.env`가 있고 권한이 600이며 `AWBS_RUNNER_TOKEN` 줄이 있는가(값은 읽지 않는다)
4. node가 26.13 이상 26 계열인가

점검을 통과하면 `~/.config/systemd/user/awbs-runner.service`를 만들고 부팅 때 자동 시작으로 등록한다.
시작은 하지 않는다. 시작은 owner가 `systemctl --user start awbs-runner.service`로 한다.
왜 시작을 따로 두나: 시작하는 순간 Runner가 서버에 붙어 일을 가져가기 시작한다. 그 시점은 owner가 정한다.

- `--dry-run`: 아무것도 바꾸지 않고 점검과 서비스 파일 검증(`systemd-analyze verify`)만 한다.
- `--uninstall`: 멈추고 지운다.

### 5.3 서비스 파일의 주요 설정과 이유

- `ExecStart=<node> --env-file=<저장소>/agent-runner/.env src/main.ts`
  - node는 nvm 경로를 절대 경로로 적는다. 사용자 systemd의 기본 PATH에는 nvm이 없기 때문이다.
  - node 버전을 바꾸면 설치 스크립트를 다시 실행해야 한다.
- `Environment=AWBS_AGENT_USER=awbs-agent`
  - `.env`보다 이 값이 먼저다. `node --env-file`은 이미 있는 환경 변수를 바꾸지 않기 때문이다.
- `Restart=on-failure`, 5분에 5번까지
  - 왜: 일시적인 오류는 스스로 회복하고, 설정 오류로 끝없이 재시작하는 일은 막는다.
- `KillMode=mixed`, `TimeoutStopSec=60`
  - 멈출 때 Runner 본체에 먼저 종료 신호를 보내 정리할 시간을 준다.
  - Agent 세션은 Runner가 만든 별도 scope라 서비스를 멈춰도 같이 끊기지 않는다. Runner가 직접 정리한다.
- `UMask=0077`: 새로 만드는 파일은 Runner 계정만 읽는다.
- `NoNewPrivileges`는 **일부러 켜지 않는다.**
  - 왜: Runner는 sudo로 실행 래퍼 하나를 불러 Agent를 전용 계정으로 띄운다. 이 설정을 켜면 sudo가 막힌다.

### 5.4 자주 쓰는 명령

- 상태: `systemctl --user status awbs-runner.service`
- 로그: `journalctl --user -u awbs-runner.service -f`
- 다시 시작: `systemctl --user restart awbs-runner.service`
- 멈춤: `systemctl --user stop awbs-runner.service`

## 6. SMTP · Telegram 연결 확인 (화면 안내)

실제 SMTP 계정과 Telegram 봇 토큰은 owner가 화면에 직접 넣는다.
아래 단계 중 **「실제로 보냄」** 표시가 있는 버튼은 진짜 메일·메시지를 보낸다. 그 버튼은 owner가 받는 사람을 확인한 뒤 누른다.

### 6.1 먼저: 접속 주소

- 위치: 설정 → 「알림」 탭 → 「Agent WBS 접속 주소」
- 값: `http://127.0.0.1:5173`
- 왜: 팀장용 메일과 Telegram 알림 속의 링크가 이 주소로 만들어진다.
- 외부 수신자에게는 링크를 넣지 않는다(Q-13 A). 그래서 이 주소가 같은 PC 주소여도 외부에는 영향이 없다.

### 6.2 메일(SMTP) — Q-13 A: owner SMTP, 외부 수신자는 PDF만

1. 설정 → 「보고서 · 메일」 탭 → 「메일 서버(SMTP)」에서 「수정」을 누른다.
2. 「SMTP 서버」(주소·포트), 「보안 방식」, 「계정」, 「비밀번호」, 「보내는 주소」를 넣고 「저장」한다.
   - Gmail·Microsoft 365는 계정 비밀번호가 아니라 앱 비밀번호를 쓴다.
   - 비밀번호는 서버가 `secret-key`로 암호화해 DB에 넣는다. 화면·API 응답·로그에 다시 나오지 않는다.
3. 「연결 확인」을 누른다. **메일을 보내지 않는다.** 서버 접속과 로그인만 확인한다.
   - 성공: 「정상」과 확인 시각이 보인다.
   - 실패: 「실패」와 원인이 보인다. 대표 원인은 로그인 실패, 포트·보안 방식 불일치, 방화벽이다.
4. 「받는 사람 추가」로 받는 사람을 넣는다.
   - 외부 사람(회사 밖, 상급자 공유용)은 「외부」를 켠다. 그러면 보고용 보기·PDF 첨부·링크 없음으로 고정된다.
5. 받는 사람 줄의 「테스트」는 **실제로 보냄**. owner 자신의 주소로 먼저 시험한다.
6. 발송 결과는 같은 탭의 「발송 기록」에서 본다.
   - 「수락 여부 불명」은 이미 도착했을 수 있다. 다시 보내면 두 번 받을 수 있으니 받은편지함을 먼저 확인한다.

### 6.3 Telegram — Q-16 A: 즉시 발송

1. Telegram 앱에서 BotFather로 봇을 만들고 토큰을 받는다.
2. 만든 봇에게 Telegram 앱에서 아무 메시지나 한 번 보낸다(또는 봇을 넣은 대화방에서 메시지를 보낸다).
   - 왜: Telegram은 봇에게 먼저 말을 건 대화만 봇이 찾을 수 있다.
3. 설정 → 「알림」 탭 → 연결 영역에 토큰을 넣고 「봇 확인」을 누른다. **메시지를 보내지 않는다**(봇 정보만 묻는다).
4. 「수신 대상 찾기」 → 「최근 대화 조회」 → 받을 대화를 골라 「이 대화 선택」. **메시지를 보내지 않는다**(최근 받은 메시지만 묻는다).
   - Webhook을 쓰는 봇이면 조회가 실패한다. 화면은 Webhook을 자동으로 풀지 않는다.
5. 「테스트 알림 보내기」는 **실제로 보냄**. 성공해야 「켜기」를 누를 수 있다.
   - 화면의 「전송 요청 수락」은 Telegram 서버가 받았다는 뜻이다. 실제 도착은 Telegram 앱에서 확인한다.
   - 토큰이나 Chat ID를 바꾸면 테스트를 다시 해야 한다. 이름만 바꾸면 그대로다.
6. 「켜기」를 누르면 그 뒤의 업무 알림은 커밋 직후 바로 간다.
7. 결과는 같은 탭의 「전송 이력」에서 본다.

### 6.4 잘 안 될 때 볼 곳

- 메일 발송 실패: 「보고서 · 메일」 탭의 발송 기록, `… logs worker`
- Telegram 실패: 「알림」 탭의 전송 이력, `… logs api`
- 컨테이너가 밖으로 나가지 못하는 경우(회사 방화벽 등)는 같은 PC의 브라우저에서 되더라도 실패할 수 있다.

## 7. 백업 · 복원 · 복원 리허설

### 7.1 백업 (`deploy/backup.sh`)

만드는 것: `~/.agentwbs/prod/backups/<UTC 시각>/` (폴더 0700, 파일 0600)

- `db.dump`: DB 전체(`pg_dump` custom 형식)
- `roles.sql`: DB 역할(`awbs_data_owner`·`awbs_app` 등). 비밀번호 해시는 넣지 않는다.
- `data.tar`: 데이터 파일 볼륨(evidence·PDF)
- `fingerprint.tsv`: 표마다 행 수와 내용 지문
- `manifest.txt`: 만든 시각, 이미지, 커밋, 트랜잭션 번호, 파일별 sha256

순서와 이유

1. api·worker를 잠깐 멈춘다.
   - 왜: DB와 데이터 파일을 같은 순간의 모습으로 뜬다. 뜨는 도중의 새 변경이 끼어들지 않는다.
2. 보고서 이력 정리(`awbs_settle_commits`)를 한 번 부른다.
   - 왜: 실제 커밋 시각은 DB 서버 내부에만 있고 `pg_dump`에 담기지 않는다. 정리가 그 시각을 `commit_real` 표에 옮겨 적어야 복원한 뒤에도 보고서의 「그때 상태」가 같다.
3. 지문 → `pg_dump` → 역할 → 데이터 파일 순서로 뜬다. 뜬 덤프를 바로 `pg_restore --list`로 읽어 본다.
4. 멈췄던 서비스를 다시 켠다. 중간에 실패해도 다시 켠다.

비밀 파일(`secrets/`)은 백업에 넣지 않는다(3장).
백업 폴더는 같은 디스크에 있다. 디스크 고장에 대비하려면 owner가 다른 저장 장치로 복사한다.

### 7.2 복원 (`deploy/restore.sh`)

- 사용: `AWBS_STACK=<대상 이름> bash …/agent-wbs/deploy/restore.sh <백업 폴더>`
- **빈 곳에만** 복원한다. 대상의 DB 볼륨이나 데이터 볼륨이 이미 있으면 멈춘다.
  - 왜: 복원이 덮어쓰기라면 실수 한 번에 지금 데이터를 잃는다.
- 대상의 `secrets/secret-key`는 백업한 쪽과 같아야 한다.
- **이미지는 백업 때와 같은 것으로만** 띄운다. 이미지를 새로 만들지 않는다.
  - `AWBS_IMAGE_TAG`를 주지 않으면 `manifest.txt`의 `image_tag`를 쓰고, 이 PC의 이미지 ID가 백업 때와 같아야 한다.
  - 같은 커밋을 다시 빌드해 ID가 달라졌다면, owner가 확인한 뒤 `AWBS_IMAGE_TAG=<꼬리표>`로 직접 정한다.
  - 이미지가 없거나 ID가 다르면 아무것도 만들기 전에 멈춘다(종료 코드 6).
  - 왜: DB를 백업 시점으로 되돌리면서 새 프로그램을 띄우면, 새 프로그램이 새 마이그레이션을 실행해 「되돌림」이 깨진다.
- 마지막에 보여 주는 기동 명령에는 꼬리표·DB 이름·구성 파일 전체 경로가 모두 들어 있다. 그대로 실행한다.

순서와 이유

1. 파일 sha256을 `manifest.txt`와 대조한다. 옮기다 깨진 파일이면 멈춘다.
2. 빈 DB 서버를 처음 띄웠다가 멈추고, 트랜잭션 번호의 epoch(64비트 번호의 위쪽 32비트)를 백업 쪽보다 1 크게 올린다(`pg_resetwal -e`).
   - 왜: 보고서 이력은 트랜잭션 번호(`xid8`)로 커밋 시각을 찾는다(`commit_log`·`commit_real`·`state_log`·`global_log`).
   - 새 DB 서버는 번호를 작은 값부터 다시 매긴다. 그대로 두면 새 변경의 번호가 백업 안의 옛 번호와 겹친다.
   - 겹치면 새 변경의 커밋 시각이 기록되지 않거나 옛 변경의 시각으로 읽혀, 보고서가 틀린 「그때 상태」를 만든다.
   - 예: 리허설(2026-11-28 04:56Z)에서 새 서버의 번호는 732였고 백업 순간의 번호는 766이었다. epoch를 올리지 않았다면 그 사이 번호가 겹쳤다.
   - **조건: `pg_resetwal -e`는 「업무 데이터를 넣기 전의 새 DB 서버를 정상 종료한 상태」에서만 쓴다.**
     - `pg_resetwal`은 WAL(장애 복구용 변경 기록)도 초기화하는 관리 도구다. 서버가 켜져 있거나, 비정상 종료했거나, 이미 업무 데이터가 있는 DB에 쓰면 데이터가 깨질 수 있다([PostgreSQL 16 설명](https://www.postgresql.org/docs/16/app-pgresetwal.html)).
     - `restore.sh`는 대상 볼륨이 없을 때만 새 서버를 만들고, 정상 종료(`stop`)한 뒤, 강제 옵션(`-f`) 없이 실행한다.
     - 살아 있는 운영 DB의 번호 문제를 이 명령으로 고치지 않는다.
3. 역할 → DB(`pg_restore`, 한 트랜잭션) → 지문 대조 → 데이터 파일 순서로 되살린다.
   - 지문이 하나라도 다르면 멈춘다.
4. api·worker는 켜지 않는다. 켜는 명령을 마지막에 보여 준다.

운영 이름(`awbs-prod`) 그대로 되살려야 할 때(디스크 손상 등)

1. 지금 볼륨을 지우기 전에, 가능하면 지금 상태도 백업한다.
2. `… down`으로 멈춘다.
3. `docker volume rm awbs-prod-pgdata awbs-prod-data`로 옛 볼륨을 지운다. **되돌릴 수 없다.** owner가 직접 판단해서 실행한다.
4. `AWBS_STACK=awbs-prod bash <저장소>/agent-wbs/deploy/restore.sh <백업 폴더>`
5. 마지막에 나온 대로 `bash <저장소>/agent-wbs/deploy/set-image.sh <꼬리표>` → `… up -d --wait`

### 7.3 복원 리허설 (`deploy/restore-rehearsal.sh`)

운영을 건드리지 않고 임시 구성 두 개로 「백업 → 새 DB에 복원 → 앱 기동 → 데이터 대조」를 끝까지 해 본다.

- 원본 `awbs-rh-src`(화면 127.0.0.1:25481)에 시험 자료(seed demo)와 데이터 파일 표식을 넣는다.
- 대상 `awbs-rh-dst`(화면 127.0.0.1:25482)에 원본 백업을 되살리고 앱을 켠다.
- DB 이름은 `awbs_test_rehearsal`이다.
  - 왜: 시험 자료 넣기는 이름이 `awbs_test_`로 시작하는 DB에만 허락된다. 운영 DB에 시험 자료가 들어갈 수 없다.
- 대조하는 것
  1. 표마다 행 수·내용 지문(앱을 켜기 전)
  2. 데이터 파일 표식의 sha256
  3. 로그인 뒤 API GET 14개의 응답 코드와 본문
     - `/api/schedule`은 「지금」 시각(`at`)과 지금 기준 계획 진척률(`plannedPct`)을 담으므로 이 두 값만 빼고 비교한다.
  4. 복원한 DB의 새 변경이 새 epoch 번호와 실제 커밋 시각을 받는지
  5. 원본·대상 모두 api·worker가 `awbs_app_login`으로 접속하는지, 관리자가 아니고 이력을 지울 수 없는지, 관리자 비밀 파일이 컨테이너에 없는지
  6. 없는 이미지 꼬리표로 복원하면 아무것도 만들기 전에 멈추는지
  7. 5.1.1대로 발급한 토큰의 heartbeat가 204인지(옛 안내 `runner-main` 토큰은 403), 실제 Runner를 20초 띄웠을 때 서버에 세션이 기록되는지
     - `runner:public-key` 명령(gh-cred)이 있어야 한다. 없으면 이 단계에서 멈춘다.
- 실행: `AWBS_IMAGE_TAG=<꼬리표> bash <저장소>/agent-wbs/deploy/restore-rehearsal.sh` (이미지는 `build.sh`로 미리 만든다)
- 끝나면 임시 구성을 `docker compose -p <임시 이름> … down -v`로 지운다. 그 구성의 컨테이너와 볼륨만 지운다.
- 기록은 `~/.agentwbs/rehearsal/<시각>/rehearsal-result.txt`에 남는다.
- 업데이트로 DB 구조가 크게 바뀐 뒤에는 리허설을 다시 한다.

## 8. 점검과 문제 해결

- 전체 상태: `… ps`
- 로그: `… logs --tail 200 api` (`worker`, `web`, `migrate`, `postgres`도 같은 방법)
- DB까지 확인: `curl -fsS http://127.0.0.1:5173/health/db` → `{"db":"ok",…}`
- migrate가 실패하면 api·worker가 시작하지 않는다. `logs migrate`로 원인을 본다.
- api 컨테이너만 다시 시작해도 된다. web(nginx)을 다시 시작하면 api도 함께 다시 시작해야 한다.
  - 왜: api는 web의 네트워크 공간을 빌려 쓴다. 주인(web)이 새로 뜨면 빌린 쪽의 네트워크가 끊긴다.
  - 명령: `… up -d --force-recreate web api`
- 지우기 규칙
  - 컨테이너 하나를 지울 때는 `docker rm -f -v <이름>`을 쓴다. 이름 없는 볼륨을 남기지 않는다.
  - `docker volume prune`, `docker system prune`은 쓰지 않는다. 다른 프로젝트의 볼륨까지 지울 수 있다.

## 9. 알려진 한계

- app 이미지가 크다(약 2.1 GB). Chromium과 그 시스템 라이브러리, 운영 의존성 전체가 들어 있기 때문이다.
- worker에는 HTTP 헬스체크가 없다(1.5).
- 무중단 교체를 하지 않는다(4.2).
- 백업은 같은 디스크에 남는다(7.1).
- 운영과 개발 화면이 같은 포트(5173)를 기본으로 쓴다(2장).
- 서버 계약을 바꾸는 배포에 필요한 옛 job 재발급 명령이 없다(4.4).
- Runner의 GitHub 연결은 `gh` 방식만 검증 범위다. `token` 방식은 gh-cred 병합 후(5.1).

## 용어

- **awbs_app_login** — 운영 api·worker 전용 DB 로그인. `awbs_app` 권한만 물려받고 `SET ROLE`은 못 한다.
- **compose secrets** — compose가 호스트의 파일을 컨테이너 안 `/run/secrets/<이름>`에 붙여 주는 기능. 값이 구성 정보에 남지 않는다.
- **digest** — 이미지 내용으로 만든 지문(`sha256:…`). 같은 digest면 같은 이미지다.
- **epoch (트랜잭션 번호)** — PostgreSQL의 64비트 트랜잭션 번호(`xid8`)에서 위쪽 32비트. 프로젝트 초기화 번호(epoch)와는 다른 말이다.
- **linger** — 로그아웃·재시작 뒤에도 그 계정의 사용자 systemd를 띄워 두는 설정.
- **loopback** — 같은 PC 안에서 자기 자신에게 접속하는 연결(`127.0.0.1`).
- **nginx** — 웹 서버 프로그램. 여기서는 화면 파일을 보내고 API 요청을 넘긴다.
- **Origin** — 브라우저 주소의 「프로토콜·호스트·포트」 묶음. 예: `http://127.0.0.1:5173`.
- **pg_dump / pg_restore** — PostgreSQL DB를 파일로 뜨는 명령과, 그 파일을 DB로 되살리는 명령.
- **pg_resetwal** — 멈춘 PostgreSQL 서버의 내부 기록을 고치는 관리 명령. 여기서는 트랜잭션 번호의 epoch를 올리는 데만 쓴다.
- **systemd 사용자 서비스** — 사용자 계정 몫의 systemd가 띄우고 관리하는 상주 프로그램.
- **볼륨** — 컨테이너를 지워도 남는 docker 데이터 저장소.
- **복원 리허설** — 실제 사고 전에 백업을 새 DB에 되살려 앱이 뜨고 데이터가 같은지 미리 해 보는 시험.
- **헬스체크** — 컨테이너가 정상인지 docker가 주기적으로 묻는 검사.
