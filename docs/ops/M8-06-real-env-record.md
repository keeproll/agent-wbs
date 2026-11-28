# M8-06 실환경 기록 — 운영 이미지 · Runner 서비스 · 백업/복원

- 기록일: 2026-11-28
- 기준 커밋: main `1ce62aa`, 작업 브랜치 `keeproll/m8-06`
- 이 PC: WSL2 + Docker Desktop 29.9.3, systemd 255, Runner 계정 keeproll(uid 1000), linger `yes`
- 설명서: [운영 설정 안내](operations.md)
- 결정: Q-13 A(owner SMTP, 외부 수신자는 PDF만), Q-15 A(배포 확인은 이 PC compose), Q-16 A(Telegram 즉시)

이 문서는 두 부분이다.
앞부분은 이번에 이 PC에서 실제로 해 본 것과 결과다.
뒷부분은 owner가 할 일이다. 명령은 모두 전체 경로이고 bash로 실행한다.

## 1. 이번에 확인한 것

### 1.1 compose 구성 검사 — 통과

```bash
docker compose -p awbs-prod -f /home/keeproll/orca/workspaces/agent-wbs/m8-06/agent-wbs/deploy/compose.prod.yaml config
```

- 종료 코드 0.
- 확인한 값: 포트는 `127.0.0.1:5173 → web 8080`만 열린다. postgres는 호스트 포트가 없다.
- postgres는 `postgres:16@sha256:07abc3f4…`(Debian), 명령 `postgres -c track_commit_timestamp=on`, 헬스체크 `pg_isready`.
- 볼륨 `awbs-prod-pgdata`, `awbs-prod-data`, 네트워크 `awbs-prod-net`.
- 비밀값은 compose secrets 파일 두 개(`db_password`, `secret_key`)로만 넘긴다. compose 출력에 비밀값이 없다.

### 1.2 이미지 빌드 — 통과

- `awbs-app:m8-06` 약 2.08 GB(API·worker·migrate 공용, Chromium 포함), `awbs-web:m8-06` 약 292 MB(nginx + 화면 파일).
- 기반 이미지는 digest로 고정했다.
  - `node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`
  - `nginxinc/nginx-unprivileged:1.29-bookworm@sha256:593a17dc61d117d1bfb208246903265abe0047c5bd4508b6e790895924b24c31`
- 앱 실행 계정은 `node`(uid 1000)이고, 프로그램 파일은 root 소유 읽기 전용(644)이다.
- 데이터 폴더 `/home/node/.agentwbs/wbs`는 `node` 소유 0700이다.
- 컨테이너 안에서 Chromium으로 한글 HTML을 PDF로 만들었다(19,469바이트, `%PDF-`로 시작). PDF 자산(`prototype.css`, Pretendard GOV 글꼴 4개)이 `dist/pdf/assets`에 있다.

### 1.3 복원 리허설 — 통과

```bash
AWBS_IMAGE_TAG=m8-06 bash /home/keeproll/orca/workspaces/agent-wbs/m8-06/agent-wbs/deploy/restore-rehearsal.sh
```

마지막 실행(2026-11-28 04:30Z) 결과:

1. 원본 구성 `awbs-rh-src`를 띄우고 시험 자료(seed demo)와 64 KiB 데이터 파일 표식을 넣었다.
2. 로그인 링크로 로그인하고 API GET 14개 응답을 저장했다.
3. `backup.sh`가 api·worker를 멈추고 → 보고서 이력 정리 → 지문 → `pg_dump` → 역할 → 데이터 파일을 뜬 뒤 다시 켰다.
   - 백업 폴더 권한 700, 파일 5개 모두 600.
   - `server_version=16.16`, `track_commit_timestamp=on`, 표 107개, `xid_at_backup=764`, `xid_epoch=0`.
4. `restore.sh`가 **새** 구성 `awbs-rh-dst`에 되살렸다.
   - sha256 대조 통과.
   - 새 서버의 첫 트랜잭션 번호는 732였다. 백업 순간 번호 764보다 작아서, 그대로 두면 번호가 겹친다(2장 F-1).
   - epoch를 0 → 1로 올린 뒤 역할 → `pg_restore`(한 트랜잭션) 순서로 되살렸다.
   - **표 107개의 행 수·내용 지문이 모두 같았다.**
   - 새 트랜잭션 번호가 백업 안의 모든 번호보다 컸다.
5. 대상 앱을 켰다. `/health/db` → `{"db":"ok"}`.
6. 대조
   - 데이터 파일 표식 sha256 같음.
   - API GET 14개 모두 200, 본문 14개 모두 같음(`/api/schedule`은 「지금」 값인 `at`·`plannedPct`만 빼고 비교).
   - 복원한 DB에서 Task 한 행을 고쳤더니 새 변경이 epoch 1 번호와 실제 커밋 시각을 받았다. 옛 번호 기록 2개는 그대로였다.
7. 임시 구성의 컨테이너·볼륨을 모두 지웠다(남은 것 0개).

전체 기록: `/home/keeproll/.orca/bots/agentwbs/archive/2026-11-28/M8-06/rehearsal-run.log`

### 1.4 Runner 서비스 — 검증만(실제 등록·시작 안 함)

- `install-runner-service.sh --dry-run --name awbs-runner-dryrun-m806` 결과
  - linger 켜짐, `awbs-agent` 계정 있음, 실행 래퍼 root 소유, node 26.13.0: OK.
  - 이 작업 폴더에는 `agent-runner/.env`가 없어 그 항목만 FAIL(예상된 결과).
  - 만든 서비스 파일의 `systemd-analyze --user verify`: 통과.
  - `~/.config/systemd/user/`에는 아무것도 만들지 않았다.
- 임시 이름 dry-run: 같은 설정(작업 폴더, PATH, `AWBS_AGENT_USER=awbs-agent`, `KillMode=mixed`, `UMask=0077`)으로 `systemd-run --user --unit=awbs-runner-dryrun-m806 --wait --collect`를 한 번 실행했다.
  - Runner 설정 읽기 성공: `agentRoot=/srv/agentwbs`, `wbsUrl=http://127.0.0.1:5173`(시험용 가짜 토큰).
  - umask 077.
  - 서비스 안에서 사용자 scope를 만들 수 있었다. scope는 서비스 cgroup 밖(`app.slice/run-u….scope`)에 생겼다.
  - git·gh·docker·systemd-run·sudo를 PATH에서 찾았다(sudo는 실행하지 않음).
  - 끝난 뒤 남은 유닛 0개.

### 1.5 Runner 토큰 발급 경로 — 확인

- 임시 구성에서 `openssl`로 만든 X25519 공개키를 표준 입력으로 넘겨 `auth runner-token`을 실행했다. 토큰(43자)이 나왔고 DB에 공개키가 저장됐다.
- 그 토큰으로 nginx를 거쳐 `POST /api/runner/heartbeat`를 빈 본문으로 보내 400을 받았다. 실제 Runner 연결 확인은 owner 단계(3장 6번)에서 한다.

### 1.6 하지 않은 것

- 실제 SMTP·Telegram 연결과 발송: 하지 않았다. owner가 화면에 값을 넣은 뒤 확인한다.
- 운영 구성 `awbs-prod`의 기동: 하지 않았다(빌드만 했다).
- Runner 서비스의 실제 등록·시작: 하지 않았다.
- sudo가 필요한 단계: 하지 않았다. 필요한 경우 아래 owner 할 일에 적었다.

## 2. 발견한 것 (보고)

- **F-1 새 DB 서버에 복원하면 트랜잭션 번호가 겹친다 — 스크립트로 막음.**
  - 보고서 상태 이력(M6-01)은 `xid8`(트랜잭션 번호)로 커밋 시각을 찾는다.
  - 새 서버는 번호를 작은 값부터 매기므로 옛 번호와 겹친다(리허설: 새 서버 732, 백업 764).
  - 겹치면 `awbs_stamp_commit`이 「이미 기록됨」으로 보고 새 변경의 커밋 시계를 남기지 않는다. 그러면 보고서가 새 변경을 옛 시각으로 읽는다.
  - `restore.sh`가 `pg_resetwal -e`로 epoch를 백업 쪽보다 1 올려 막는다. 리허설 8단계로 확인했다.
  - data-model 문서에는 이 복원 조건이 없다. 문서에 적을지는 리뷰 때 정해 주면 좋겠다.
- **F-2 운영에서 화면 파일은 api가 아니라 web(nginx)이 보낸다 — 문서와 다름.**
  - architecture §2·§6.1은 「api가 정적 web을 함께 서빙」이라고 적는다.
  - 이번 구현은 web 컨테이너(nginx)가 화면 파일을 보내고 `/api`·`/health`를 api로 넘긴다. api 코드는 바꾸지 않았다.
  - 왜: api는 모든 경로에 권한 선언이 있어야 기동한다(security.ts). 그래서 화면 경로를 api에 더하려면 계약(OPERATIONS)을 바꿔야 한다. 또 api가 컨테이너 밖으로 직접 들으면 LAN 공개로 판단해 비밀번호가 필요해진다.
  - 문서를 고칠지, api 서빙으로 바꿀지 결정이 필요하다.
- **F-3 Telegram 발송은 worker가 아니라 api 프로세스에서 돈다 — 문서와 다름.**
  - architecture §2는 worker가 「알림 outbox」를 맡는다고 적는다.
  - 코드는 `apps/api/src/main.ts`의 `startNotifyWorker`로 api 프로세스 안에서 보낸다. 운영 구성도 코드를 따른다.
- **F-4 Runner 토큰의 공개키를 어디서 받는지 정해진 절차가 없다.**
  - `auth runner-token <ID> <공개키 파일>`은 공개키 파일을 요구한다.
  - 그런데 `agent-runner/src/github/README.md` §5는 Runner가 시작할 때마다 새 키 쌍을 메모리에서 만들고, 공개키 등록 API는 아직 없다고 적는다.
  - 그래서 지금은 owner가 `openssl`로 만든 공개키로 토큰을 발급한다(3장 6번). 이 공개키는 Runner 메모리의 키와 다르다. GitHub 토큰 봉인 전달을 쓰는 시점에는 따로 정해야 한다.
- **F-5 운영 화면 포트 5173이 개발 화면(vite) 포트와 같다.**
  - architecture §6.1이 정한 값이라 그대로 두었다. 동시에 띄우려면 한쪽을 바꾼다(operations §2).
- **F-6 서버 계약을 바꿔 배포할 때 옛 job 재발급 절차가 아직 없다.**
  - milestones M8-06과 architecture §6.3이 「이 전에 정한다」고 적은 항목이다. 이번 범위(이미지·compose·백업)에서는 정하지 않았다.

## 3. owner가 할 일

아래는 병합 뒤 저장소 `/home/keeproll/projects/agent-wbs` 기준이다.
명령은 Runner 계정(keeproll)으로, **bash**에서 한 줄씩 실행한다.
결과가 기대와 다르면 실행한 명령, 화면 출력 전체, 종료 코드(`echo exit=$?`)를 보내 주면 된다.

### 0단계. 준비 확인

- [ ] 병합된 저장소인지 확인

  ```bash
  ls /home/keeproll/projects/agent-wbs/agent-wbs/deploy/compose.prod.yaml /home/keeproll/projects/agent-wbs/agent-runner/deploy/install-runner-service.sh
  ```

- [ ] linger 확인. `Linger=yes`가 보이면 된다.

  ```bash
  loginctl show-user keeproll -p Linger
  ```

  - `Linger=no`이면(관리자 권한, 비밀번호를 물음): `sudo loginctl enable-linger keeproll`
- [ ] Agent 전용 계정 설치가 끝났는지 확인. 아직이면 `/home/keeproll/projects/agent-wbs/agent-runner/docs/OWNER-RUNBOOK.md` 1~6단계를 먼저 한다.

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-runner/scripts/isolation/check-agent-user.sh; echo exit=$?
  ```

- [ ] 5173 포트가 비어 있는지 확인. 아무것도 안 나오면 비어 있다. 개발 화면(vite)이 쓰고 있으면 끄거나 operations §2대로 포트를 바꾼다.

  ```bash
  ss -ltn 'sport = :5173'
  ```

### 1단계. 비밀 파일 만들기

- [ ] 실행

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/prod-init.sh
  ```

- [ ] `secret-key`를 암호 관리자 등 **백업과 다른 곳**에 복사한다. 아래 명령으로 값을 보고 복사한 뒤 터미널 화면을 지운다.

  ```bash
  cat /home/keeproll/.agentwbs/prod/secrets/secret-key; echo; read -r -p '복사했으면 Enter: '; clear
  ```

### 2단계. 이미지 빌드

- [ ] 실행(몇 분 걸린다). 꼬리표는 지금 커밋 해시다.

  ```bash
  AWBS_IMAGE_TAG=$(git -C /home/keeproll/projects/agent-wbs rev-parse --short HEAD) docker compose -p awbs-prod -f /home/keeproll/projects/agent-wbs/agent-wbs/deploy/compose.prod.yaml build
  ```

### 3단계. 기동과 확인

- [ ] 기동. 마지막에 api·web이 `Healthy`, migrate가 `Exited`이면 된다.

  ```bash
  AWBS_IMAGE_TAG=$(git -C /home/keeproll/projects/agent-wbs rev-parse --short HEAD) docker compose -p awbs-prod -f /home/keeproll/projects/agent-wbs/agent-wbs/deploy/compose.prod.yaml up -d --wait
  ```

- [ ] DB까지 확인. `{"db":"ok",…}`가 나오면 된다.

  ```bash
  curl -fsS http://127.0.0.1:5173/health/db; echo
  ```

### 4단계. 로그인과 프로젝트 등록

- [ ] 1회용 로그인 링크를 받아 브라우저로 연다.

  ```bash
  docker compose -p awbs-prod -f /home/keeproll/projects/agent-wbs/agent-wbs/deploy/compose.prod.yaml exec -T api awbs-entrypoint auth login-link
  ```

- [ ] 화면에서 프로젝트를 등록한다(개발 때와 같은 등록 흐름).

### 5단계. 화면 설정(실제 값은 owner가 입력)

operations §6의 순서를 따른다. 「실제로 보냄」 버튼은 받는 사람을 확인하고 누른다.

- [ ] 설정 → 「알림」 → 「Agent WBS 접속 주소」에 `http://127.0.0.1:5173` 저장
- [ ] 설정 → 「보고서 · 메일」 → SMTP 저장 → 「연결 확인」이 「정상」(보내지 않음)
- [ ] 받는 사람 추가. 회사 밖 사람은 「외부」 켜기(Q-13 A: PDF만, 링크 없음)
- [ ] owner 자신의 주소 줄에서 「테스트」(실제로 보냄) → 받은편지함 확인 → 「발송 기록」 확인
- [ ] 설정 → 「알림」 → 봇 토큰 → 「봇 확인」(보내지 않음)
- [ ] 봇에게 Telegram 앱에서 메시지 한 번 보내기 → 「수신 대상 찾기」 → 「최근 대화 조회」 → 「이 대화 선택」(보내지 않음)
- [ ] 「테스트 알림 보내기」(실제로 보냄) → Telegram 앱에서 도착 확인 → 「켜기」 → 저장

### 6단계. Runner 토큰 발급과 Runner 설정

- [ ] 공개키 만들기(2장 F-4 참고: 지금은 임시 절차)

  ```bash
  ( umask 077; mkdir -p /home/keeproll/.agentwbs/prod/runner && openssl genpkey -algorithm X25519 -out /home/keeproll/.agentwbs/prod/runner/runner-key.pem && openssl pkey -in /home/keeproll/.agentwbs/prod/runner/runner-key.pem -pubout -out /home/keeproll/.agentwbs/prod/runner/runner-pub.pem )
  ```

- [ ] 토큰 발급. 출력된 한 줄이 토큰이다. 화면에 한 번만 나오므로 바로 다음 칸에서 `.env`에 넣는다.

  ```bash
  docker compose -p awbs-prod -f /home/keeproll/projects/agent-wbs/agent-wbs/deploy/compose.prod.yaml exec -T api awbs-entrypoint auth runner-token runner-main /dev/stdin < /home/keeproll/.agentwbs/prod/runner/runner-pub.pem
  ```

- [ ] Runner 설정 파일 열기. 아래 세 줄이 있게 고친다(이미 있는 GitHub 설정 줄은 그대로 둔다). 토큰을 명령 이력에 남기지 않으려고 편집기를 쓴다.

  ```bash
  touch /home/keeproll/projects/agent-wbs/agent-runner/.env && chmod 600 /home/keeproll/projects/agent-wbs/agent-runner/.env && nano /home/keeproll/projects/agent-wbs/agent-runner/.env
  ```

  ```text
  AWBS_URL=http://127.0.0.1:5173
  AWBS_RUNNER_TOKEN=<위에서 나온 토큰>
  AWBS_AGENT_USER=awbs-agent
  ```

- [ ] Runner 의존성 설치(처음 한 번, 이미 했으면 건너뜀)

  ```bash
  pnpm -C /home/keeproll/projects/agent-wbs/agent-runner install --frozen-lockfile
  ```

### 7단계. Runner 서비스 설치와 시작

- [ ] 미리 보기. 점검이 모두 `OK`이고 `systemd-analyze verify: 통과`면 된다.

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-runner/deploy/install-runner-service.sh --dry-run
  ```

- [ ] 설치(부팅 때 자동 시작 등록. 아직 시작은 안 함)

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-runner/deploy/install-runner-service.sh
  ```

- [ ] 개발용으로 터미널에서 돌리던 Runner가 있으면 먼저 끈다(그 터미널에서 `Ctrl+C`). 같은 `AWBS_HOME`은 Runner 하나만 쓸 수 있다.
- [ ] 시작과 확인. `active (running)`이 보이면 된다.

  ```bash
  systemctl --user start awbs-runner.service && systemctl --user status awbs-runner.service --no-pager
  ```

- [ ] 로그에서 연결 확인. `Runner 시작` 뒤에 오류가 이어지지 않으면 된다. 화면 설정 → 「Runner · 실행 환경」에서도 연결 상태를 본다.

  ```bash
  journalctl --user -u awbs-runner.service -n 50 --no-pager
  ```

### 8단계. 첫 백업과 리허설

- [ ] 첫 백업. 마지막 줄이 백업 폴더다.

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/backup.sh
  ```

- [ ] (권장) 백업 폴더를 다른 저장 장치로 복사한다.
- [ ] (선택) 이 PC에서 복원 리허설을 직접 한 번 돌린다. 마지막 줄이 `결과: 통과`면 된다. 운영 구성은 건드리지 않는다.

  ```bash
  AWBS_IMAGE_TAG=$(git -C /home/keeproll/projects/agent-wbs rev-parse --short HEAD) bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/restore-rehearsal.sh
  ```

### 9단계. 결과 알려 주기

- [ ] 아래를 보내 주면 기록을 마무리한다.
  1. 3단계 `/health/db` 출력
  2. 5단계 SMTP 「연결 확인」 결과, 테스트 메일 도착 여부, Telegram 테스트 도착 여부
  3. 7단계 `systemctl --user status` 첫 5줄
  4. 8단계 백업 폴더 경로(내용은 보내지 않는다)
