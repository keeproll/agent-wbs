# M8-06 실환경 기록 — 운영 이미지 · Runner 서비스 · 백업/복원

- 기록일: 2026-11-28 (리뷰 반영 2차)
- 기준: main `1ce62aa`, 작업 브랜치 `keeproll/m8-06`
- 이 PC: WSL2 + Docker Desktop 29.9.3, systemd 255, Runner 계정 keeproll(uid 1000), linger `yes`
- 설명서: [운영 설정 안내](operations.md)
- 결정: Q-13 A(owner SMTP, 외부 수신자는 PDF만), Q-15 A(배포 확인은 이 PC compose), Q-16 A(Telegram 즉시)

이 문서는 세 부분이다.

1. 이 PC에서 실제로 해 본 것과 결과
2. 발견한 것과 처리, owner 결정이 필요한 것
3. owner가 할 일(명령은 모두 전체 경로, bash)

## 1. 이번에 확인한 것

### 1.1 compose 구성 검사 — 통과

```bash
AWBS_IMAGE_TAG=6273888 docker compose -p awbs-prod -f /home/keeproll/orca/workspaces/agent-wbs/m8-06/agent-wbs/deploy/compose.prod.yaml config --quiet
```

- 종료 코드 0. 꼬리표 없이 실행하면 「AWBS_IMAGE_TAG(이미지 꼬리표)를 정하세요」로 멈춘다(의도한 동작).
- 공개 포트는 `127.0.0.1:5173 → web 8080` 하나다. postgres는 호스트 포트가 없다.
- postgres는 `postgres:16@sha256:07abc3f4…`(Debian), `track_commit_timestamp=on`, 헬스체크 `pg_isready`.
- 이미지를 만드는 항목(`build`)이 없고 `pull_policy: never`다.
- 비밀 파일 연결: postgres는 `db_password`, migrate는 `db_password`·`db_app_password`, api·worker는 `db_app_password`·`secret_key`.

### 1.2 이미지 — 통과

- `bash agent-wbs/deploy/build.sh`로 `awbs-app:6273888`, `awbs-web:6273888`를 만들었다(커밋 `6273888`).
- 이미지에 커밋 표시(`org.agentwbs.commit`)를 붙인다. 백업 manifest의 `git_commit`이 이 값을 쓴다.
- 앱 실행 계정은 `node`(uid 1000), 프로그램 파일은 root 소유 읽기 전용이다. 컨테이너 안 Chromium PDF 생성은 1차 기록에서 확인했다.

### 1.3 복원 리허설 — 통과 (2026-11-28 07:06~07:08Z, main(gh-cred PR #22) 병합 뒤)

```bash
AWBS_IMAGE_TAG=6273888 bash /home/keeproll/orca/workspaces/agent-wbs/m8-06/agent-wbs/deploy/restore-rehearsal.sh
```

1. 원본 `awbs-rh-src`를 띄웠다.
2. **원본 앱 DB 권한**: `{"currentUser":"awbs_app_login","superuser":false,"historyWritable":[],"historyDeleteBlocked":true,"setRoleBlocked":true,"disableTriggerBlocked":true,"membershipSafe":true}`.
   - api·worker 1번 프로세스의 DB 사용자는 `awbs_app_login`이고, 두 컨테이너에 관리자 비밀 파일(`/run/secrets/db_password`)이 없다.
3. 시험 자료(seed demo)와 64 KiB 데이터 파일 표식을 넣고, 로그인 뒤 API GET 14개를 저장했다.
4. `backup.sh`: 폴더 700, 파일 600. manifest에 `image=awbs-app:6273888`, `image_id`, `web_image`, `web_image_id`, `image_tag=6273888`, `git_commit=6273888…`, `xid_at_backup=767`, `xid_epoch=0`, 표 107개.
5. **없는 꼬리표로 복원 시도**(`AWBS_IMAGE_TAG=no-such-tag-m806`): 종료 코드 6으로 멈췄고 만든 볼륨은 0개였다.
   - **이미지 ID가 빠진 manifest**(`image_id`·`web_image_id` 줄을 지운 사본, 꼬리표 생략): 「manifest의 image_id 가 없거나 형식이 잘못되었습니다」로 종료 코드 6, 만든 볼륨 0개.
6. **꼬리표를 주지 않고 복원**: manifest의 꼬리표를 골라 이미지 ID가 같음을 확인했다(「manifest와 ID 같음」).
   - 새 서버의 번호 732, 백업 순간의 번호 767 → epoch 0 → 1.
   - 표 107개의 행 수·내용 지문이 모두 같았다.
7. 대상 앱 기동: `/health/db` → `{"db":"ok"}`.
8. **대상 앱 DB 권한**: 원본과 같은 결과. 역할은 백업에서 되살리고(비밀번호 없이), migrate가 대상의 `db-app-password`로 비밀번호를 맞췄다.
9. 대조: 데이터 파일 표식 같음, API 14개 모두 200·본문 같음(`/api/schedule`은 `at`·`plannedPct` 제외).
10. 새 변경: epoch 1 번호와 실제 커밋 시각을 받았다. 옛 번호 기록 2개 유지.
11. **Runner 연결 재현**(operations 5.1.1 순서대로)
    - `runner:public-key` 명령 → Runner ID `13acb221-c09e-4506-98eb-aa0926258b5c`, 공개키 파일 권한 600.
      - 이 명령은 gh-cred 작업(PR #22, main 병합됨)이 추가했다. 이 브랜치는 그 main을 병합한 뒤 그대로 실행했다.
    - 그 식별자로 발급한 토큰의 heartbeat → **204**. 옛 안내(`runner-main`) 토큰 → **403**.
    - 실제 Runner(`agent-runner/src/main.ts`)를 그 토큰으로 20초 띄웠다. 서버에 그 식별자의 세션 기록 1개가 생겼다.
    - gh-cred의 키 형식 검사가 앱 로그인 entrypoint(`awbs-entrypoint auth`)에서도 동작한다: 공개키가 아닌 파일로는 토큰을 내주지 않았다(종료 코드 1). 올바른 공개키로는 같은 entrypoint가 토큰을 발급했다.
    - token 방식: 화면 API로 시험용 GitHub 토큰을 저장(200)하고 Runner를 `AWBS_GITHUB_MODE=token`으로 25초 띄웠다. api 접근 기록에서 봉인 키 등록 `POST /api/runner/github/key` → **200**, 봉인 조회 `GET /api/runner/github/credential` → **200**(404 아님). GitHub API 주소는 닫힌 로컬 포트로 두어 바깥 GitHub에는 요청하지 않았다.
12. 임시 구성의 컨테이너·볼륨을 모두 지웠다(남은 것 0개).

전체 기록: `/home/keeproll/.orca/bots/agentwbs/archive/2026-11-28/M8-06/rehearsal-run-fix3.log` (이미지 `6273888`). 앞선 판: `rehearsal-run-fix2.log`(`b59baf9`), `rehearsal-run-fix1.log`(`ef25de2`)
- 같은 검사를 `01b1c11`(Runner ID를 이 브랜치의 임시 명령으로 확인하던 판)에서도 한 번 통과했다: `rehearsal-run-fix1-01b1c11.log`

### 1.4 시험·검사

- `agent-runner`: `pnpm test` 통과(131 파일 2,400개, main 병합 뒤). 이 브랜치의 코드 변경은 `src/github/README.md` 문장 하나다.
  - Runner ID 확인 명령은 gh-cred 작업의 `runner:public-key`를 쓴다(같은 기능을 따로 만들지 않음, 조정자 지시).
- `agent-wbs`: `typecheck`·`lint`·`test`(102 파일 2,090개)·`test:db --maxWorkers 2`(54 파일 882개) 통과(main 병합 뒤). 새 DB 시험 `packages/db/test/app-login.db.test.ts` 4개 포함(전용 시험 DB 컨테이너).
  - 재리뷰 재현: 멤버십에 ADMIN이 남아 있으면 앱 로그인이 스스로 `SET TRUE` 멤버십을 주고 `SET ROLE`에 성공한다. 검사(`membershipSafe`)가 이를 잡고, migrate의 맞추기가 준 사람별 멤버십을 모두 회수해 `ADMIN FALSE, INHERIT TRUE, SET FALSE` 하나만 남긴다. 그 뒤 앱의 자기 부여는 `42501`로 막힌다.
  - 앱 로그인이 관리자가 아니고, 이력 삭제·비우기·트리거 끄기·`SET ROLE`이 막히고, 앱 일(읽기, 보고서 기준점 함수)은 된다.
  - 실수로 준 다른 역할을 migrate가 회수하고 `SET` 불가를 되살린다.

### 1.5 Runner 서비스 — 검증만(실제 등록·시작 안 함)

- 1차 기록과 같다: `install-runner-service.sh --dry-run`의 점검과 `systemd-analyze --user verify` 통과, 임시 이름 유닛으로 설정 읽기·umask 077·사용자 scope 생성 확인, 남은 유닛 0개.

### 1.6 하지 않은 것

- 실제 SMTP·Telegram 연결과 발송, 운영 구성 `awbs-prod` 기동, Runner 서비스 실제 등록·시작, sudo 단계.

## 2. 발견한 것과 처리

- **F-1 새 DB 서버로 복원하면 트랜잭션 번호가 겹친다 — `restore.sh`가 막음.**
  - `pg_resetwal -e`로 epoch를 올린다. **조건: 업무 데이터를 넣기 전의 새 DB 서버를 정상 종료한 상태에서만** 쓴다. operations §7.2와 data-model §6에 적었다.
- **F-2 화면 파일은 web(nginx)이 보낸다 — 구현 유지, architecture §2·§6.1·§6.3을 고침.**
- **F-3 Telegram 발송은 api 프로세스에서 돈다 — 구현 유지, architecture §2의 worker 설명을 고침.**
- **F-4 Runner 키와 GitHub 연결 — 안내를 고침.**
  - 기본은 `AWBS_GITHUB_MODE=gh`다. 기존 `.env` 확인 단계를 넣었다(3장 6단계).
  - 토큰 발급 때 넣는 공개키는 「이 Runner를 승인한다」는 기록이다. 서버 인증은 Bearer 토큰이 맡는다.
  - GitHub 봉인용 키는 Runner가 실행 중에 만들어 `POST /api/runner/github/key`로 등록하는 키다. 서버 처리기는 gh-cred(PR #22)로 main에 들어왔다. 리허설 9단계에서 token 방식 Runner의 키 등록·봉인 조회가 정상임을 확인했다(실제 GitHub 연결은 확인하지 않음).
  - `agent-runner/src/github/README.md`의 「공개키 등록 API는 아직 계약에 없어」 문장을 사실대로 고쳤다.
- **F-5 운영 화면 포트 5173 = 개발 vite 포트.** 동시 기동 시 한쪽을 바꾼다(operations §2).
- **F-6 서버 계약을 바꾸는 배포 때 옛 job 처리 — owner (A) 결정 뒤 지원 명령 구현(2026-11-28).**
  - 아래 다섯 답은 M8-06 당시의 확인 기록이다. 후속 구현을 포함한 현재 절차는 [operations §4.4](operations.md#44-서버-계약을-바꾸는-배포-옛-job-처리)를 따른다.
    1. 수령 중지: 서버 설정은 없고 Runner를 멈추는 것뿐이다.
    2. 실행 중 일: Runner가 멈추면 worker 감시가 **상태를 바꿀 때** `split`·`estimate`·`planning`은 `cancelled`, `input_diff`·`bootstrap`은 `reconcile`이 된다. 보유는 `unconfirmed`로 남는다. `GET /api/runner-state`의 `sessions`는 Task 시도만 보여 주므로 모든 일의 종료 확인 수단이 아니다.
    3. 임대·fence: 일반 Runner 경로는 임대 시각까지 보지만, Planning 경로(`assertJob`)는 fence와 상태만 본다. 그래서 안전한 거절 기준은 시간 경과가 아니라 **실제 상태 변화나 fence 변경**이다. `queued` 옛 일은 그대로 남는다.
    4. 다시 만들기: `queued` 일을 취소·재발급하는 API·CLI가 없다. 분할 요청은 같은 내용의 열린 옛 일을 돌려주고, `reconcile` 대조는 옛 입력으로 새 일을 넣을 수 있다.
    5. 확인: 대기 일과 종료 미확인 보유를 보여 주는 지원 명령이 없다.
  - owner에게 드린 선택지(결정: **A**)
    - (A) 최소 명령 두 개(`jobs open` 읽기 전용, `jobs reissue` 옛 `queued` 일 취소+재발급)를 만들고, 그 전까지 계약 변경 배포를 하지 않는다. **추천.** 왜: 사람 규칙만으로는 `queued` 옛 일을 볼 수도 바꿀 수도 없다.
    - (B) 명령을 만들지 않고 「계약 변경 배포 금지」 규칙만 둔다. 계약을 바꿔야 하면 프로젝트 초기화로 해결한다. 왜 비추천: 초기화는 프로젝트 자료를 지운다.
    - (C) 서버에 「수령 일시 중지」 설정을 추가하고, 대기 일이 다 소화될 때까지 기다린 뒤 배포한다. 왜 비추천: 대기 일을 볼 명령이 여전히 필요하고, 새 Runner가 옛 입력을 가져가는 문제는 그대로다.
  - 후속 작업에서 `awbs-entrypoint auth jobs open`·`auth jobs reissue`를 추가했다. 계약 변경 배포는 operations §4.4의 정지·기존 계약에서의 정리·고정 순번 재발급 절차를 따를 때만 진행한다. 대조·종료 미확인 보유가 남으면 배포 금지를 유지한다.
- **(리뷰 P1-1) 운영 앱이 DB 관리자로 접속하던 문제 — 고침.** api·worker는 `awbs_app_login`으로 접속하고, 관리자 비밀 파일은 앱 컨테이너에 붙지 않는다(1.3의 2·8번).
- **(리뷰 P1-2) 안내대로 발급한 토큰이 403이던 문제 — 고침.** 토큰을 gh-cred의 `runner:public-key` 명령이 알려 주는 실제 Runner ID로 발급하도록 안내를 바꿨다(1.3의 11번). gh-cred는 main에 병합됐다(PR #22).
- **(재리뷰 P2-1) 앱 로그인 멤버십에 ADMIN 옵션이 남을 수 있던 문제 — 고침.** `ADMIN FALSE`를 명시하고 준 사람별 멤버십을 모두 회수한 뒤 다시 준다. `db-check`에 `membershipSafe`를 넣었다.
- **(재리뷰 P2-2) 이미지 ID가 빠진 manifest를 기본 복원이 받아 주던 문제 — 고침.** 두 ID가 없거나 형식이 틀리면 자원을 만들기 전에 종료 코드 6으로 멈춘다(1.3의 5번).
- **(재리뷰 P2-3) F-6 설명이 코드보다 강하던 문제 — 고침.** 일반 Runner 경로와 Planning 경로(`assertJob`)의 검사 차이, `unconfirmed` 보유, `sessions`의 한계, `reconcile` 대조의 옛 입력을 적고, 안전 거절 기준을 상태 변화·fence 변경으로 한정했다. 당시에는 계약 변경 배포 금지를 유지했다. 후속 명령 구현 뒤의 현재 조건은 operations §4.4를 따른다.
- **(리뷰 P1-3) 복원이 지금 소스로 이미지를 자동 빌드하던 문제 — 고침.** compose에서 `build`를 없애고, 복원은 manifest의 꼬리표·ID로만 띄운다(1.3의 5·6번).

## 3. owner가 할 일

병합 뒤 저장소 `/home/keeproll/projects/agent-wbs` 기준이다.
명령은 Runner 계정(keeproll)으로, **bash**에서 한 줄씩 실행한다.
결과가 기대와 다르면 실행한 명령, 화면 출력, 종료 코드(`echo exit=$?`)를 보내 주면 된다.
**비밀값(토큰·비밀번호·키)이 보이는 출력은 보내지 않는다.**

### 0단계. 준비 확인

- [ ] 병합된 저장소인지 확인

  ```bash
  ls /home/keeproll/projects/agent-wbs/agent-wbs/deploy/build.sh /home/keeproll/projects/agent-wbs/agent-wbs/deploy/set-image.sh
  ```

- [ ] linger 확인. `Linger=yes`가 보이면 된다. `no`이면 관리자 권한으로 `sudo loginctl enable-linger keeproll`.

  ```bash
  loginctl show-user keeproll -p Linger
  ```

- [ ] Agent 전용 계정 점검. 마지막에 `FAIL 0개`면 된다. 아직 설치 전이면 `/home/keeproll/projects/agent-wbs/agent-runner/docs/OWNER-RUNBOOK.md` 1~6단계를 먼저 한다.

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-runner/scripts/isolation/check-agent-user.sh; echo exit=$?
  ```

- [ ] 5173 포트가 비어 있는지 확인. 아무것도 안 나오면 비어 있다.

  ```bash
  ss -ltn 'sport = :5173'
  ```

### 1단계. 비밀 파일 만들기와 키 따로 보관

- [ ] 실행. `db-password`, `db-app-password`, `secret-key`가 생긴다.

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/prod-init.sh
  ```

- [ ] `secret-key`를 백업과 **다른 곳**에 파일째로 보관한다. **터미널에 출력하지 않는다.** 둘 중 하나:
  - 암호 관리자의 파일 첨부·가져오기로 `/home/keeproll/.agentwbs/prod/secrets/secret-key` 파일을 올린다.
  - 다른 저장 장치에 복사한다(예: Windows의 D 드라이브가 USB라면):

    ```bash
    install -m 0600 /home/keeproll/.agentwbs/prod/secrets/secret-key /mnt/d/awbs-secret-key
    ```

### 2단계. 이미지 만들기와 꼬리표 정하기

- [ ] 이미지 만들기(몇 분). 마지막 줄이 꼬리표다.

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/build.sh
  ```

- [ ] 그 꼬리표로 정하기(`<꼬리표>`를 바꿔 넣는다)

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/set-image.sh <꼬리표>
  ```

### 3단계. 기동과 확인

- [ ] 기동. 마지막에 api·web이 `Healthy`, migrate가 `Exited`면 된다.

  ```bash
  docker compose -p awbs-prod -f /home/keeproll/projects/agent-wbs/agent-wbs/deploy/compose.prod.yaml --env-file /home/keeproll/.agentwbs/prod/deploy.env up -d --wait
  ```

- [ ] DB까지 확인. `{"db":"ok",…}`가 나오면 된다.

  ```bash
  curl -fsS http://127.0.0.1:5173/health/db; echo
  ```

- [ ] 앱 DB 권한 확인. `"currentUser":"awbs_app_login","superuser":false`이고 `historyWritable`이 `[]`면 된다.

  ```bash
  docker compose -p awbs-prod -f /home/keeproll/projects/agent-wbs/agent-wbs/deploy/compose.prod.yaml --env-file /home/keeproll/.agentwbs/prod/deploy.env exec -T api awbs-entrypoint db-check
  ```

### 4단계. 로그인과 프로젝트 등록

- [ ] 1회용 로그인 링크를 받아 브라우저로 연다(링크는 한 번 쓰면 끝이다. 보고에 보내지 않는다).

  ```bash
  docker compose -p awbs-prod -f /home/keeproll/projects/agent-wbs/agent-wbs/deploy/compose.prod.yaml --env-file /home/keeproll/.agentwbs/prod/deploy.env exec -T api awbs-entrypoint auth login-link
  ```

- [ ] 로그인만 확인한다. 프로젝트 등록은 7단계의 Runner 준비와 아래 「작업 수신 확인」을 마친 뒤 한다.

### 5단계. 화면 설정(실제 값은 owner가 입력)

operations §6 순서를 따른다. 「실제로 보냄」 버튼은 받는 사람을 확인하고 누른다.

- [ ] 설정 → 「알림」 → 「Agent WBS 접속 주소」에 `http://127.0.0.1:5173` 저장
- [ ] 설정 → 「보고서 · 메일」 → SMTP 저장 → 「연결 확인」이 「정상」(보내지 않음)
- [ ] 받는 사람 추가. 회사 밖 사람은 「외부」 켜기(Q-13 A: PDF만, 링크 없음)
- [ ] owner 자신의 주소 줄에서 「테스트」(실제로 보냄) → 받은편지함 확인 → 「발송 기록」 확인
- [ ] 설정 → 「알림」 → 봇 토큰 → 「봇 확인」(보내지 않음)
- [ ] 봇에게 Telegram 앱에서 메시지 한 번 → 「수신 대상 찾기」 → 「최근 대화 조회」 → 「이 대화 선택」(보내지 않음)
- [ ] 「테스트 알림 보내기」(실제로 보냄) → Telegram 앱에서 도착 확인 → 「켜기」 → 저장

### 6단계. Runner 설정 확인과 토큰 발급

- [ ] 개발용으로 터미널에서 돌리던 Runner가 있으면 끈다(그 터미널에서 `Ctrl+C`). 서비스로 켜 둔 것이 있으면:

  ```bash
  systemctl --user stop awbs-runner.service 2>/dev/null; true
  ```

- [ ] Runner 의존성 설치(처음 한 번, 이미 했으면 건너뜀)

  ```bash
  pnpm -C /home/keeproll/projects/agent-wbs/agent-runner install --frozen-lockfile
  ```

- [ ] 기존 `.env`를 검증하고 켜짐 여부·한도 확인. 토큰이 잘못 붙은 줄도 원문으로 보여 주지 않는다. 토큰을 아직 넣지 않았다면 설정 오류를 해결한 뒤 다시 확인한다.

  ```bash
  pnpm -C /home/keeproll/projects/agent-wbs/agent-runner exec node --env-file-if-exists=.env --input-type=module -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.env); console.log({githubConfigured:!!c.github,githubMode:c.github?.mode,attemptAuto:c.attemptAuto,ciAuto:c.ciAuto,planningAuto:c.planningAuto,agentCallLimit:c.agentCallLimit,agentMaxEffort:c.agentMaxEffort});'
  ```

  - `AWBS_GITHUB_MODE`: 줄이 없으면 기본값 `gh`다. `token`이면 화면에 GitHub 토큰을 저장하는 절차(`/home/keeproll/projects/agent-wbs/docs/runner-github-setup.md`)를 함께 따른다. 실제 GitHub 연결은 아직 어느 방식으로도 이 기록에서 확인하지 않았다.
  - `AWBS_GITHUB_REPO`가 있어야 기본으로 `repo_check`·`github_check`를 받는다. 두 확인에는 유료 호출이 없다.
  - `AWBS_ATTEMPT_AUTO=1`은 개발·검증, `AWBS_CI_AUTO=1`은 통합·재실행·배포 확인이다. 기본 꺼짐이다. 초기 분석은 별도 `AWBS_PLANNING_AUTO=1`과 두 모델 설정(`AWBS_PLANNING_CODEX_MODEL`·`AWBS_PLANNING_CLAUDE_MODEL`)이 있어야 한다.
  - 유료 검증 전체는 `AWBS_CALL_LIMIT=30` 이내로 owner가 정한다(기본 0). `AWBS_AGENT_MAX_EFFORT=high`가 최대다. 초기 분석·Planning·계약 반영·개발·검증·형식 수정 요청이 같은 장부를 쓰며, 하위 Agent는 끈다. 실행 허가 직전 차감 뒤 실패·취소도 소비하고 `AWBS_HOME/paid-calls.json`을 재시작·초기화로 지우지 않는다.
  - M8 검증 동안 owner가 정한 값은 **`AWBS_CALL_LIMIT=30`, `AWBS_AGENT_MAX_EFFORT=high`**다. 기본 한도 0은 유지한다. `AWBS_ATTEMPT_AUTO=1`이어도 한도 0이면 시도·AI 분석·하위 Agent 실행은 꺼지며, 무료 확인·CI는 해당 플래그 조건대로 계속한다. 이전 이름 `AWBS_AGENT_CALL_LIMIT`은 호환용이고 새 이름과 값이 충돌하면 시작 오류다.
  - 시작 로그와 설정 → Runner · 실행 환경의 「유료 AI 호출 한도」에서 **「유료 호출 한도 0: AI 실행 꺼짐」** 또는 **「유료 호출 한도 도달: AI 실행 꺼짐」**, 사용/전체·남은 횟수·최대 Effort를 확인한다. 호출별 순번·시각·job·모델·Effort·CLI 종료 결과도 보이며, 5초마다 서버 상태를 갱신한다. 프롬프트·인증정보·업무 결과 원문은 이 기록에 넣지 않는다. `unknown`은 결과 미확인으로 보존하며 자동 환불하지 않는다.
  - 호출 횟수는 해당 작업의 슬롯 확보와 프로세스 등록 뒤 실제 CLI 실행 허가 직전에 차감한다. 그 전에 실패·취소되면 차감하지 않는다. 허가 직전 차감과 실제 실행 사이에 취소·전원 장애가 나면 과소 집계를 피하려고 소비한 채 둔다.
  - 재부팅으로 bootId가 바뀌면 저장된 start 본문을 새 부팅 정보로 덮어쓰지 않는다. 옛 실행 종료 증거만 보고하고 임대 갱신을 멈춘다. 외부 효과가 가능한 job은 서버 만료 뒤 기존 reconcile 절차로 원격 결과를 확인한다. 다시 호출하거나 성공으로 추정하지 않는다.

- [ ] `runner:public-key` 명령이 있는지 확인(gh-cred, PR #22로 main에 들어옴). 아래 명령이 파일 경로를 보여 주면 된다. 없으면 저장소가 최신 main이 아니므로 멈추고 알려 준다.

  ```bash
  ls /home/keeproll/projects/agent-wbs/agent-runner/scripts/runner-public-key.ts
  ```

- [ ] 공개키 파일 만들기와 Runner 식별자 확인. 한 줄로 나오는 UUID가 식별자다(공개키 파일이 이미 있으면 실패한다. 그때는 다른 파일 이름을 쓴다).

  ```bash
  ( umask 077; mkdir -p /home/keeproll/.agentwbs/prod/runner ) && pnpm -s -C /home/keeproll/projects/agent-wbs/agent-runner runner:public-key /home/keeproll/.agentwbs/prod/runner/runner-pub.pem
  ```

- [ ] 토큰 발급(`<식별자>`를 위에서 나온 값으로 바꾼다). 출력 한 줄이 토큰이다. 화면에 한 번만 나오므로 바로 다음 칸에서 `.env`에 넣고, 이 출력은 보고에 보내지 않는다.

  ```bash
  docker compose -p awbs-prod -f /home/keeproll/projects/agent-wbs/agent-wbs/deploy/compose.prod.yaml --env-file /home/keeproll/.agentwbs/prod/deploy.env exec -T api awbs-entrypoint auth runner-token <식별자> /dev/stdin < /home/keeproll/.agentwbs/prod/runner/runner-pub.pem
  ```

- [ ] `.env` 열어 고치기. 아래 세 줄이 있게 한다(이미 있는 GitHub 설정 줄은 그대로 둔다).

  ```bash
  touch /home/keeproll/projects/agent-wbs/agent-runner/.env && chmod 600 /home/keeproll/projects/agent-wbs/agent-runner/.env && nano /home/keeproll/projects/agent-wbs/agent-runner/.env
  ```

  ```text
  AWBS_URL=http://127.0.0.1:5173
  AWBS_RUNNER_TOKEN=<위에서 나온 토큰>
  AWBS_AGENT_USER=awbs-agent
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

- [ ] 시작과 확인. `active (running)`이 보이면 된다.

  ```bash
  systemctl --user start awbs-runner.service && systemctl --user status awbs-runner.service --no-pager
  ```

- [ ] 로그 확인. `Runner 시작` 뒤에 `FORBIDDEN_PRINCIPAL`이나 오류가 이어지지 않으면 된다. 화면 설정 → 「Runner · 실행 환경」에서도 연결 상태를 본다.

  ```bash
  journalctl --user -u awbs-runner.service -n 50 --no-pager
  ```

### 8단계. 첫 백업과 리허설

7단계 뒤 작업 수신도 확인한다. 시작 로그만으로 등록 흐름이 끝났다고 보지 않는다.

- [ ] 프로젝트 화면에서 「저장소 접근 확인」 → private·main 커밋·필수 구조가 실제 보고로 표시됨.
- [ ] 설정 → Runner → 「연결 확인」 → 마지막 확인 시각이 바뀜. 두 버튼은 유료 CLI를 부르지 않는다.
- [ ] owner가 분석 예산·모델·격리를 허용한 경우에만 등록 → 초기 분석의 Codex·Claude·교차 검토 완료 → 기술 결정 확인 → WBS 초안까지 확인한다. 한도나 시스템 배포 키가 없으면 보류·실패 이유를 먼저 해결한다.
- [ ] 사용 호출 수(`AWBS_HOME/paid-calls.json`의 `used`)를 기록한다. 전체 30회·1회 high 이내이며, 초기 분석 이후 시도·형식 수정도 이 수에 포함한다.

이번 수신 연결의 검증은 전용 PostgreSQL 16·실제 API·Runner 앱·브라우저·가짜 CLI로 위 화면 흐름까지다. 실제 유료 CLI, 실제 GitHub 쓰기, 운영 자원, SMTP·Telegram 발송을 검증한 기록으로 바꾸어 읽으면 안 된다. 전체 job 목록과 켜짐 조건은 [Runner README](../../agent-runner/README.md)를 따른다.

- [ ] 첫 백업. 마지막 줄이 백업 폴더다.

  ```bash
  bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/backup.sh
  ```

- [ ] (권장) 백업 폴더를 다른 저장 장치로 복사한다. `secret-key`와 같은 곳에 두지 않는다.
- [ ] (선택) 복원 리허설. 마지막 줄이 `결과: 통과`면 된다. 운영 구성은 건드리지 않는다.

  ```bash
  AWBS_IMAGE_TAG=$(sed -n 's/^AWBS_IMAGE_TAG=//p' /home/keeproll/.agentwbs/prod/deploy.env) bash /home/keeproll/projects/agent-wbs/agent-wbs/deploy/restore-rehearsal.sh
  ```

### 9단계. 결정과 결과 알려 주기

- [x] F-6 선택지: (A)로 정함(2026-11-28). 후속 job 재발급 명령 구현. 계약 변경 배포는 operations §4.4의 절차를 따를 때만 진행한다.
- [ ] 아래를 보내 준다(비밀값이 보이는 출력은 빼고).
  1. 3단계 `/health/db`와 `db-check` 출력
  2. 5단계 SMTP 「연결 확인」 결과, 테스트 메일 도착 여부, Telegram 테스트 도착 여부
  3. 7단계 `systemctl --user status` 첫 5줄
  4. 8단계 백업 폴더 경로(내용은 보내지 않는다)
