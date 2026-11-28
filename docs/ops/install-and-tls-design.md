# 설계: 설치 명령 하나 · systemctl 기동/종료 · 전 구간 HTTPS(TLS)

- 상태: **설계안 3판(설계 마지막 판)**(코드는 아직 바꾸지 않았다). 구현은 다음 단계에서 별도 작업자가 한다. 남은 구현 수준 확인은 8장 「구현 단계 확인 목록」(T-1~T-21)으로 넘긴다.
- 기준: main `827b06c`, 작성 2026-11-28. 2판은 Codex 교차 리뷰(P1 6건·P2 5건), 3판은 2차 리뷰(P1 4건·P2 2건)를 반영했다. 항목별 대응은 부록 C.
- owner 지시(요약): ① `install.sh --prefix=/opt` 한 번으로 설치 ② `systemctl start/restart/stop agent-wbs.service`로 기동·종료 ③ Runner도 같은 방식 ④ 모든 통신은 https(TLS). 127.0.0.1 안에서도 http를 쓰지 않는다 ⑤ 사설 인증서가 필요하면 owner에게 요청하고 파일·절차를 알려 준다.
- 함께 보는 문서: [운영 설정 안내](operations.md), [Agent 실행 격리](../../agent-runner/docs/isolation.md), owner용 인증서 절차 `owner-cert.md`(작업 기록 폴더 `install-tls/`)

이 문서는 처음 보는 사람도 읽을 수 있게 썼다.
처음 나오는 말은 그 자리에서 풀어 쓰고, 맨 끝 「용어」에 모았다.
결정마다 「왜」를 한두 문장으로 붙였다.

## 0. 한 장 요약

owner가 앞으로 쓰는 명령은 이것뿐이다.

```bash
# 설치·업그레이드(같은 명령). 저장소 맨 위 폴더에서.
sudo bash install.sh --prefix=/opt

# 서버
sudo systemctl start   agent-wbs.service
sudo systemctl restart agent-wbs.service
sudo systemctl stop    agent-wbs.service
systemctl status agent-wbs.service

# Runner
sudo systemctl start|restart|stop agent-wbs-runner.service
systemctl status agent-wbs-runner.service

# 제거(데이터·비밀·백업은 남긴다)
sudo /opt/agent-wbs/bin/uninstall.sh
```

바뀌는 것 다섯 가지

1. 설치 위치: 저장소 폴더와 `~/.agentwbs/prod`에 흩어져 있던 실행 파일·설정·비밀을 `<prefix>/agent-wbs/`, `<prefix>/agent-runner/` 아래로 모은다.
2. 서버 기동: `docker compose … up` 대신 **시스템 서비스** `agent-wbs.service`가 compose를 대신 불러 준다.
3. Runner 기동: 사용자 서비스 `awbs-runner.service`(`systemctl --user`) 대신 **시스템 서비스** `agent-wbs-runner.service`(실행 계정은 그대로 keeproll).
4. 주소: `http://127.0.0.1:5173` → **`https://127.0.0.1:8443`**(포트는 owner 결정 O-1). http 포트는 아예 열지 않는다.
5. 내부 연결도 TLS: nginx→api(`/api/`·`/health`·`/health/db` 모두), api·worker·migrate→postgres까지 TLS로 바꾸고 인증서를 반드시 검증한다. 설치 때의 내려받기(apt·npm·Playwright)도 https만 쓴다.
6. 아직 TLS가 아닌 곳은 숨기지 않고 표(5.1)에 적고 owner에게 묻는다: GitHub 시스템 push(SSH), SMTP STARTTLS, 개발 구성(O-6, O-10).

owner에게 요청하는 것: **사설 인증서 파일 만들기**(명령 한 칸, `owner-cert.md`)와 Windows에 CA 등록(PowerShell 한 줄).

## 1. 지금 모습과 바뀐 뒤 모습

### 1.1 지금(main `827b06c`)

```text
Windows 브라우저 ──http──▶ 127.0.0.1:5173 ─▶ [web nginx :8080] ─http─▶ [api 127.0.0.1:3100] ─평문─▶ [postgres :5432]
Runner(systemd --user) ─http─▶ 127.0.0.1:5173/api ┘                       [worker] ─평문─────────┘
실행 위치: 저장소 폴더(/home/keeproll/projects/agent-wbs), 비밀: ~/.agentwbs/prod/secrets (keeproll 0600)
기동: docker compose -p awbs-prod -f …/compose.prod.yaml --env-file ~/.agentwbs/prod/deploy.env up -d --wait
```

### 1.2 바뀐 뒤

```text
                 (A) TLS, web 인증서               (B) TLS, api 인증서            (C) TLS, db 인증서
Windows 브라우저 ═══https═══▶ 127.0.0.1:8443 ─▶ [web nginx :8443] ═══https═══▶ [api 127.0.0.1:3100] ═══TLS═══▶ [postgres :5432]
  (CA를 Windows 신뢰 저장소에 등록)              proxy_ssl_verify on                           [worker]  ═══TLS═══┘
                                                                                             [migrate] ═══TLS═══┘
Runner(agent-wbs-runner.service, User=keeproll) ═══https(CA 고정)═══▶ 127.0.0.1:8443/api  (D)
   └─ sudo 래퍼 · systemd-run --user scope · git/gh → GitHub https (E: 이미 TLS)
api/worker → SMTP(SSL/TLS·STARTTLS만) · Telegram https (F)

systemd: agent-wbs.service ──(docker compose up/down)──▶ 컨테이너 5개
         agent-wbs-runner.service ──▶ node src/main.ts (keeproll)
파일:    /opt/agent-wbs/{bin,releases,current,etc,var}   /opt/agent-runner/{runtime,releases,current,etc}
```

## 2. 설치 레이아웃

### 2.1 결정: 프로그램·설정·비밀·백업을 모두 prefix 안에 둔다

`/etc`, `/var/lib`로 나누지 않고 `<prefix>/agent-wbs/` 한 곳에 모은다.

- 왜: owner가 「지정한 디렉토리 아래로 설치」를 원했다. 한 폴더만 보면 무엇이 설치됐는지, 무엇을 백업·제거할지 알 수 있다.
- 왜 괜찮나: 이 PC 한 대만 쓰는 구성이라 여러 패키지가 `/etc`를 나눠 쓰는 이점이 없다. 대신 「프로그램」(`releases/`)과 「바꾸면 안 되는 것」(`etc/`, `var/`)을 하위 폴더로 확실히 나눈다.
- 다른 선택(FHS식 `/etc/opt/agent-wbs`, `/var/opt/agent-wbs`)은 owner 결정 O-2에 남긴다.

예외 두 가지(prefix 밖에 남는 것)

1. **DB·데이터 파일**은 지금처럼 docker 이름 있는 볼륨 `awbs-prod-pgdata`, `awbs-prod-data`에 둔다.
   - 왜: 이 PC의 docker는 Docker Desktop이다. 볼륨은 Docker Desktop의 가상 머신 안에 있어 WSL 폴더(`/opt`)로 옮길 수 없다. 이름을 그대로 쓰면 지금 운영 데이터를 옮기지 않고 이어 쓴다.
2. **Runner 데이터 폴더** `/home/keeproll/.agentwbs`(Runner ID·bare 저장소·상태)는 그대로 둔다.
   - 왜: Runner 토큰이 이 폴더의 Runner ID에 묶여 있다(operations §5.1.1). 격리 설계도 「Agent는 Runner 홈을 못 읽는다」를 전제로 한다(isolation §1). 옮기면 둘 다 다시 검증해야 한다.

### 2.2 서버 폴더 `<prefix>/agent-wbs/`

```text
/opt/agent-wbs/                       root:root 0755
├─ bin/
│   ├─ agent-wbs                      관리 명령(아래 2.4). root:root 0755
│   └─ uninstall.sh                   제거
├─ share/                             root:root 0755  누구나 읽는 공개 파일
│   └─ ca.crt                         공개 CA 인증서 사본 0644. owner의 curl 확인·갱신 명령·Runner(서버만 설치한 PC가 아닐 때)가 쓴다
├─ releases/
│   ├─ 827b06c/                       설치한 판 하나 = 커밋 하나. root 소유·읽기 전용
│   │   ├─ deploy/compose.prod.yaml, pg_hba.conf, backup.sh, restore.sh, restore-rehearsal.sh …
│   │   ├─ contracts.sha256           서버 계약 파일 지문(업그레이드 때 계약 변경 감지, 2.6)
│   │   └─ docs/ops/…                 그 판의 설명서
│   └─ 9f1e2d3/ …
├─ current -> releases/9f1e2d3        지금 쓰는 판(링크). 되돌리기 = 링크만 바꾼다
├─ etc/                               root:root 0755  ※ 설치·업그레이드가 절대 덮어쓰지 않는다
│   ├─ agent-wbs.env                  비밀 아닌 설정(이미지 꼬리표·포트·Origin·그룹 번호). root 0644
│   ├─ secrets/                       root:awbs-secret 0750
│   │   ├─ db-password                root:awbs-secret 0640
│   │   ├─ db-app-password            root:awbs-secret 0640
│   │   └─ secret-key                 root:awbs-secret 0640
│   └─ tls/                           root:awbs-secret 0750
│       ├─ ca.crt                     공개. 0644
│       ├─ web.crt / web.key          nginx용. crt 0644, key root:awbs-secret 0640
│       ├─ api.crt / api.key          api용
│       └─ db.crt  / db.key           postgres용
└─ var/                               root:root 0700
    ├─ backups/<UTC 시각>/            backup.sh 결과(지금과 같은 내용)
    ├─ tls-old/<시각>/                 인증서 갱신 때 바꾸기 전 파일(되돌리기용, 5.9)
    └─ install-log/<시각>.log          설치·업그레이드 기록(비밀값 없음)
```

- `etc/tls/`는 비밀 그룹 폴더(0750)라 **사람 계정은 그 안의 공개 `ca.crt`도 읽지 못한다.** 폴더를 통과할 권한이 없기 때문이다. 그래서 공개 사본을 `share/ca.crt`에 따로 둔다. owner를 비밀 그룹에 넣어 해결하지 않는다.
- prefix는 **리눅스 파일시스템**이어야 한다. install.sh는 `/mnt/<드라이브>`(Windows 드라이브, DrvFS)처럼 리눅스 권한(0600·0640)을 지키지 못하는 위치를 거부한다.
  - 왜: 리뷰에서 metadata 없는 Windows 드라이브는 `chmod 0600`을 해도 0777로 보이는 것을 확인했다. 비밀 파일 권한 설계가 통째로 무너진다.

- 시스템 서비스 파일은 systemd가 읽는 곳에 둔다: `/etc/systemd/system/agent-wbs.service`. 이것은 prefix 밖에 두는 유일한 설치 파일이다.
  - 왜: systemd는 정해진 폴더의 서비스 파일만 읽는다. `systemctl link`로 prefix 안 파일을 연결할 수도 있지만, prefix가 다른 디스크면 부팅 순서에 따라 못 읽는 일이 생긴다.

#### 2.2.1 비밀·키 파일의 주인: 전용 그룹 `awbs-secret`

- install.sh가 시스템 그룹 `awbs-secret`을 하나 만든다(사람 계정은 넣지 않는다).
- 비밀·키 파일은 `root:awbs-secret 0640`. 컨테이너에는 compose의 `group_add: ["${AWBS_SECRET_GID}"]`로 그 그룹 번호만 붙인다.
- 왜 uid로 맞추지 않나: 컨테이너 안 계정 번호가 이 PC의 **다른 계정 번호와 겹친다.** 이 PC에서 확인한 값:
  - postgres 컨테이너 uid 999 = 이 PC의 `verum-exec`(다른 프로젝트 계정), gid 999 = `systemd-journal`
  - nginx 컨테이너 uid 101 = 이 PC의 `messagebus`
  - 그래서 키 파일 주인을 999·101로 하면 그 계정들이 우리 키를 읽는다. 전용 그룹은 그런 겹침이 없다.
- 지금의 비밀 파일(`keeproll` 0600, 컨테이너 uid 1000과 우연히 같아서 읽힘)도 같은 방식으로 바꾼다. 그러면 「keeproll이 uid 1000이어야 한다」는 조건(operations §3.1)이 사라진다.
- 컨테이너마다 붙이는 파일은 지금처럼 compose secrets로 **필요한 것만** 붙인다. 그룹이 같아도 붙이지 않은 파일은 컨테이너 안에 없다.
- 검증: 이 PC에서 키를 `root:4242 0640`으로 두고 nginx(101)·node(1000)·postgres(999)를 `group_add 4242`로 띄워 읽히는 것, `group_add` 없이는 nginx가 `Permission denied`로 멈추는 것을 확인했다(부록 A).

### 2.3 Runner 폴더 `<prefix>/agent-runner/`

```text
/opt/agent-runner/                    root:root 0755
├─ bin/agent-wbs-runner               Runner 관리 명령(preflight 등). root 0755
├─ runtime/node-v26.13.0/             Runner 전용 node 배포본 통째(bin/node·npm·npx + pnpm 12.16.1 고정 설치). root 소유
├─ runtime/current -> node-v26.13.0   서비스 PATH는 runtime/current/bin
├─ var/legacy/<옛 커밋>/               이행 되돌리기용 옛 Runner 복구본(코드·운영 의존성·옛 node·옛 서비스 파일, 6.1). root 소유, 읽기 0755
├─ releases/<커밋>/                    agent-runner 소스 + 운영 의존성(node_modules). root 소유·읽기 전용
├─ current -> releases/<커밋>
└─ etc/                               root:root 0755  ※ 덮어쓰지 않는다
    ├─ runner.env                     비밀 아닌 설정(AWBS_URL·AWBS_CA_FILE·AWBS_HOME·AWBS_GITHUB_MODE 등). root 0644
    ├─ ca.crt                         서버 CA(공개). 0644
    └─ secrets/                       root:root 0700
        └─ runner-token               Runner 토큰. root 0600 → systemd가 서비스에만 건넨다(LoadCredential, 4.4)
```

- 왜 node를 따로 두나: 지금 서비스는 keeproll의 nvm 경로(`~/.nvm/…/node`)를 가리킨다. nvm에서 버전을 바꾸거나 지우면 서비스가 바로 멈춘다. 설치한 node는 root 소유라 Runner도 Agent도 바꿀 수 없다.
- **node 하나만 두면 안 된다(리뷰 P1-1).** Runner는 node 말고도 `npm`(CLI 버전 조회·설치, `cli-update/registry.ts`)과 `pnpm`(준비 점검 `readiness/checks.ts`의 `pnpm --version`)을 PATH에서 찾는다. 이 PC의 npm·pnpm은 nvm 폴더의 링크라, node만 복사하면 둘 다 사라진다.
  - 이 PC 재현: node만 둔 PATH → `npm=MISSING`, `pnpm=MISSING`. 배포본 통째 + pnpm 고정 설치 → `node v26.13.0`, `npm 12.2.2`, `pnpm 12.16.1`이 모두 runtime 안에서 찾아짐(부록 A-2).
- 어떻게 마련하나
  1. node 공식 배포본(`https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz`)을 받고 같은 곳의 `SHASUMS256.txt`로 sha256을 대조한 뒤 푼다. npm·npx·corepack이 함께 들어 있다.
     - 왜 nvm 폴더를 통째로 복사하지 않나: nvm 폴더에는 사람이 따로 설치한 전역 패키지(이 PC에서는 `codex`)도 들어 있다. 서비스 runtime에 섞이면 안 된다.
     - 인터넷이 없을 때는 `--node-tarball <파일> --node-shasums <SHASUMS256.txt>`로 **같은 공식 tarball 파일**을 받는다. 미리 받아 둔 파일을 쓸 뿐 내용은 온라인 경로와 같다(배포본 통째, `bin/npm`·`bin/npx` 링크 포함). 리뷰2 P2-5에서 2판의 「`bin/node`·`lib/node_modules/npm`만 복사」는 `bin/npm`·`bin/npx` 링크가 빠져 npm을 못 찾는 것으로 확인돼 **그 방식은 없앴다.**
     - 어느 경로든 마지막에 서비스 PATH로 `node`·`npm`·`npx`·`pnpm` 실행 점검(3번)을 통과해야 한다.
  2. pnpm은 그 runtime의 npm으로 **버전을 고정해** 설치한다: `npm install --global --prefix <runtime> --registry=https://registry.npmjs.org pnpm@12.16.1`(`agent-runner/package.json`의 `packageManager`와 같은 버전).
     - 왜 corepack 링크를 쓰지 않나: corepack은 처음 쓸 때 pnpm을 몰래 내려받아 사용자 캐시에 둔다. 서비스 실행 중의 숨은 네트워크 의존이 된다.
  3. 설치 점검(서비스와 **같은 PATH·같은 계정**으로): `node --version`(26.13 이상 26 계열), `npm --version`, `pnpm --version`이 모두 `runtime/current/bin` 안의 파일로 찾아지는지, 그리고 Runner 준비 점검(Agent CLI를 실제로 부르지 않는 무과금 점검)이 통과하는지 본다. 하나라도 실패하면 서비스 파일을 설치하지 않는다.
- 왜 프로그램을 root 소유로 두나: Runner(keeproll)가 뚫려도 자기 코드를 고쳐 다음 시작 때 다른 일을 하게 만들 수 없다. 서버 이미지에서 프로그램 파일을 root 소유로 두는 것(Dockerfile 주석)과 같은 이유다.

### 2.4 관리 명령 `agent-wbs`

사람이 compose 앞부분을 손으로 쓰지 않게 하나로 묶는다. 모두 `sudo`로 실행한다.

| 명령 | 하는 일 |
| --- | --- |
| `agent-wbs status` | 서비스·컨테이너 상태, 인증서 만료일, 이미지 꼬리표 |
| `agent-wbs logs <api\|worker\|web\|postgres\|migrate> [-f]` | 컨테이너 로그 |
| `agent-wbs login-link` | 1회용 로그인 링크(https 주소) |
| `agent-wbs runner-token <Runner ID> <공개키 파일>` | Runner 토큰 발급(4.5에서 install.sh가 자동으로 부른다) |
| `agent-wbs jobs open\|reissue …` | operations §4.4 그대로 |
| `agent-wbs backup` | 지금의 `backup.sh`를 `var/backups/`로 |
| `agent-wbs restore <백업 폴더>` | 지금의 `restore.sh`(빈 곳에만 복원 규칙 그대로) |
| `agent-wbs use <꼬리표>` | 되돌리기: `current` 링크와 `AWBS_IMAGE_TAG`를 바꾸고 `systemctl reload` |
| `agent-wbs compose <인자…>` | 고급: 고정 compose 앞부분(`-p awbs-prod -f … --env-file …`) + 인자 |
| `agent-wbs preflight`, `agent-wbs wait-docker <초>` | 서비스가 시작 직전에 부르는 점검(3장) |
| `agent-wbs start`, `stop`, `after-start` | 서비스 파일이 부르는 시작·멈춤·시작 뒤 정리(3.2). 이번 실행에서 `up`을 시도한 뒤 실패·시간 초과·중단되면 `after-start`가 같은 project를 `down`으로 정리한다 |
| `agent-wbs renew-cert <새 인증서 폴더>` | 같은 CA로 서버 인증서 셋 교체(5.9) |
| `agent-wbs replace-ca <새 CA 폴더> --old-thumbprint <옛 지문>` | CA 자체 교체(5.9). 새 CA로 검증하고 서버·공개 사본·Runner 신뢰를 함께 바꾼다 |
| `agent-wbs certcheck` | 인증서 만료 확인. 매일 도는 `agent-wbs-certcheck.timer`가 부른다(5.9) |

### 2.5 이미지 빌드 방식

결정: **설치 때 저장소에서 빌드한다**(지금 `build.sh` 그대로).

- 왜: 이 PC 한 대에서 저장소를 직접 쓰고 있다. 이미지 저장소(registry)나 내려받기용 묶음을 따로 두면 관리할 것만 늘어난다.
- install.sh는 `sudo`로 실행하지만 **빌드는 원래 사용자(`SUDO_USER`, keeproll)로 내려서** 한다.
  - 왜: 저장소 주인은 keeproll이다. root로 git을 돌리면 git이 「dubious ownership(주인이 다른 저장소)」으로 거부한다. 우회 설정(`safe.directory`)을 root에 넣는 것보다 원래 사용자로 돌리는 편이 안전하다.
- 지금 규칙을 그대로 지킨다: 커밋하지 않은 변경이 있으면 멈춘다, 꼬리표 = 커밋 해시, compose에는 `build`가 없고 `pull_policy: never`.
- **빌드 중 내려받기도 https만 쓴다(리뷰 P1-6).**
  - 문제: app 이미지 기반(`node:26.13.0-bookworm-slim`, digest 고정)의 apt 출처가 `http://deb.debian.org/debian`, `http://deb.debian.org/debian-security`다. Dockerfile의 `playwright-core install --with-deps`가 이 출처로 시스템 라이브러리를 받는다. apt는 패키지 서명을 검사하지만 **전송은 평문**이다.
  - 함정(이 PC 확인): 이 slim 이미지에는 **CA 묶음(`ca-certificates`)이 없다.** 출처만 https로 바꾸면 `No system certificates available`로 모두 실패한다. CA 묶음을 설치하려면 apt가 필요하니 닭과 달걀 문제다.
  - 해결: Dockerfile의 apt 앞에서
    1. digest로 고정한 다른 이미지(이미 쓰는 `nginx-unprivileged` digest, `ca-certificates` 20230311+deb12u1 포함)에서 `COPY --from=<그 이미지> /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt`
    2. `sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources`
    3. `apt-get update` → 첫 패키지로 `ca-certificates`를 설치(이후는 시스템 묶음 사용) → Playwright 의존성
  - 확인(부록 A-2): 위 1·2를 흉내 낸 컨테이너에서 `apt-get update`가 https로 성공했고 평문 http 내려받기는 0줄이었다.
  - 나머지 내려받기: npm·pnpm(`registry.npmjs.org`), Playwright Chromium(`cdn.playwright.dev`), docker 기반 이미지(digest 고정, registry https), node 배포본(`nodejs.org`)은 모두 https다. node는 자체 CA 목록을 가지고 있어 시스템 묶음이 없어도 검증한다.
  - 인수 조건(W1): 캐시 없는 빌드(`--no-cache`)의 로그에 `http://`로 시작하는 내려받기 줄이 0개.
- 미리 만든 이미지(`docker save` 묶음)로 설치하는 방법은 다른 PC에 설치할 일이 생기면 추가한다(`--image-archive <파일>`, 지금은 만들지 않음).

### 2.6 처음 설치 · 다시 설치 · 업그레이드 · 되돌리기 · 제거

모두 같은 `install.sh`다. 이미 설치돼 있는지는 `<prefix>/agent-wbs/etc/agent-wbs.env`가 있는지로 판단한다.

**공통 원칙**

- **덮어쓰기 금지**: `etc/` 아래 파일은 없을 때만 만든다. 있으면 「이미 있음(그대로 둠)」만 출력한다. 비밀 파일은 값을 읽거나 보여 주지 않고 권한·주인·크기만 확인한다.
- **두 번 실행 안전**: 같은 커밋으로 두 번 실행하면 두 번째는 바뀌는 것이 없다. `releases/<커밋>/`이 이미 있으면 내용 지문(sha256 목록)을 대조하고, 같으면 넘어가고 다르면 멈춘다.
- **먼저 점검, 나중에 변경**: 점검(3.3의 preflight와 같은 항목)이 하나라도 실패하면 아무것도 바꾸지 않고 끝낸다. `--dry-run`은 점검과 「무엇을 할지」 목록만 보여 준다.
- **원자적 교체**: 새 판은 `releases/<커밋>.tmp`에 다 만든 뒤 이름을 바꾸고, `current` 링크도 새 링크를 만든 뒤 `mv -T`로 한 번에 바꾼다. 중간에 실패해도 옛 판이 그대로 남는다.

**처음 설치**(`etc/agent-wbs.env` 없음)

1. 점검: Ubuntu+systemd, docker 응답, `docker compose` v2, 인증서 폴더(`--tls-from`, 기본 `/home/<SUDO_USER>/awbs-tls`) 안 6개 파일과 `openssl verify`, 포트 비어 있음.
2. 그룹 `awbs-secret` 만들기(없을 때만).
3. `etc/` 만들기: 비밀 3개 새로 만들기 **또는** `--import-secrets=<옛 폴더>`(기본: `/home/<SUDO_USER>/.agentwbs/prod`가 있으면 그것)에서 **복사**. 옛 파일은 지우지 않는다.
   - 가져오기 모드에서는 세 파일이 **모두** 있고 형식이 맞아야 한다(비밀번호 영문·숫자 48자, secret-key 16진수 64자 — 값은 출력하지 않고 길이·문자 종류만 본다). 하나라도 없거나 틀리면 **새로 만들어 채우지 않고 멈춘다.**
     - 왜: `secret-key`를 새로 만들면 DB에 암호화해 둔 SMTP 비밀번호·Telegram·GitHub 토큰을 다시 열 수 없다. 조용히 새 값을 만드는 것이 가장 나쁜 실패다.
   - 복사 뒤 `cmp`로 원본과 같은지 확인한다(출력은 「같음」만).
4. 인증서 복사: `--tls-from` 폴더에서 `etc/tls/`로 복사. **CA 키(`ca-offline/ca.key`)는 복사하지 않는다.**
5. 빌드(keeproll로) → `releases/<커밋>/` → `current`.
6. 서비스 파일 설치 → `systemctl daemon-reload` → `enable`(부팅 때 자동 시작). **시작은 하지 않는다.** 마지막에 시작 명령을 보여 준다.
   - 왜 시작을 따로 두나: 지금 Runner 설치와 같은 이유다. 일이 시작되는 시점은 owner가 정한다.

**업그레이드**(이미 설치됨, 새 커밋)

1. 점검 → 2. 빌드 → 3. **자동 백업**(`agent-wbs backup`, 실패하면 멈춤. 배포 전 백업은 정해진 규칙, architecture §6.3)
4. 서버 계약이 바뀌었는지 본다: 새 판과 지금 판의 `contracts.sha256`이 다르면 **멈추고** operations §4.4 절차를 안내한다. owner가 그 절차를 끝낸 뒤 `--contract-change-checked`를 붙여 다시 실행해야 진행한다.
   - 왜: 계약 변경 배포는 옛 job 정리가 끝났을 때만 안전하다(operations §4.4). 사람이 잊어도 설치기가 막는다.
5. `releases/<새 커밋>/` → `current` 교체 → `AWBS_IMAGE_TAG` 갱신 → 서비스가 켜져 있으면 `systemctl reload agent-wbs.service`(migrate가 먼저 돌고, 성공하면 api·worker가 새 이미지로 바뀐다).
6. `https://127.0.0.1:8443/health/db` 확인. 실패하면 되돌리기 명령(`agent-wbs use <옛 꼬리표>`)을 보여 준다.

**되돌리기**: `sudo /opt/agent-wbs/bin/agent-wbs use <옛 꼬리표>`. 마이그레이션은 앞으로만 가므로, 표 구조가 바뀐 판이면 지금처럼 배포 직전 백업을 복원한다(operations §4.3).

**제거**: `sudo /opt/agent-wbs/bin/uninstall.sh`

- 서비스 멈춤·`disable`·서비스 파일 삭제, `bin/`·`releases/`·`current` 삭제.
- **남기는 것**: `etc/`(비밀·인증서), `var/`(백업), docker 볼륨, docker 이미지, Runner 데이터 폴더.
  - 왜: 제거는 「프로그램을 내린다」이지 「데이터를 버린다」가 아니다. 잘못 지우면 되돌릴 수 없다.
- `--purge`: `etc/`·`var/`까지 지운다. 실행 전에 지울 폴더 이름을 그대로 입력하게 한다. 그때도 **docker 볼륨은 지우지 않고**, 지우는 명령(`docker volume rm awbs-prod-pgdata awbs-prod-data`)만 보여 준다(operations §7.2와 같은 원칙).
- `docker volume prune`·`docker system prune`은 어떤 스크립트에서도 쓰지 않는다.

**백업·복원과의 관계**

- 백업 내용·순서·복원 규칙(빈 곳에만, 같은 이미지로만, epoch 올리기)은 **바꾸지 않는다.** 위치만 `var/backups/`로 바뀐다.
- 옛 백업(`~/.agentwbs/prod/backups/`)은 옮기지 않는다. `agent-wbs restore <옛 백업 폴더>`로 그대로 쓸 수 있다.
- 비밀·인증서(`etc/`)는 지금처럼 백업에 넣지 않는다. `secret-key`와 CA 키는 따로 보관한다(operations §3.2, owner-cert.md).
- 복원 리허설은 운영과 다른 이름(`awbs-rh-*`)으로 띄우므로 같은 인증서를 그대로 쓴다. db 인증서 이름이 서비스 이름 `postgres`라서 스택 이름과 상관없이 맞는다.
- **리허설 스크립트는 경로만 바꿔서는 새 판에서 돌지 않는다(리뷰 P1-4).** `restore-rehearsal.sh`는 로그인 Origin·health·heartbeat·Runner의 `AWBS_URL`에 `http://127.0.0.1:<포트>`를 직접 쓰고 Runner에 CA도 주지 않는다. 그래서 W2에서 함께 바꾼다.
  - 주소: `https://127.0.0.1:<리허설 포트>`, Origin도 https.
  - `curl`: 모두 `--cacert <prefix>/agent-wbs/share/ca.crt`(검증 끄기 금지).
  - 리허설 Runner: `AWBS_CA_FILE`과 production 설정(https 필수)으로 띄운다.
  - `seed-demo`용 별도 `docker run`: 새 entrypoint가 요구하는 CA secret(`ca_crt`)과 DB TLS 설정을 같이 넘긴다.
  - fake GitHub 경계(`AWBS_GITHUB_API_URL=http://127.0.0.1:9`)는 **시험 전용**이라고 스크립트에 적고, production 설정 검사(W4)를 시험 모드에서만 비켜 가게 한다.
  - 두 종류를 구분한다. ① **현재 판 TLS 복원 시험**: 새 이미지·새 compose·TLS로 백업→복원→대조. ② **이행 전 HTTP 이미지 복원 시험**: 옛 백업을 옛 이미지로 되살릴 때는 그 판의 옛 compose(http, TLS 헬스체크 없음)로 띄운다. 새 TLS 헬스체크를 옛 이미지에 붙이지 않는다.
  - 이 리허설이 「기존 볼륨을 `user: 999:999`로 여는가」(5.4)의 확인 수단이므로, 이것이 통과하기 전에는 이행(6.1)을 하지 않는다.

## 3. 서버 서비스 `agent-wbs.service`

### 3.1 이 PC의 docker는 Docker Desktop이다(중요)

이 PC에서 확인한 사실:

- `systemctl`에 `docker.service`가 **없다**. `docker info`의 OperatingSystem은 `Docker Desktop`이다.
- `/usr/bin/docker`는 `/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker`를 가리키는 링크다. **Docker Desktop이 켜져 있을 때만** 이 파일이 있다.
- 그래서 `Requires=docker.service`를 쓰면 서비스가 아예 시작되지 않는다(`systemd-analyze verify`: `Unit docker.service not found`).

결정

- install.sh가 docker 종류를 알아낸다.
  - `docker.service`가 있으면(일반 Docker Engine): `Requires=docker.service`, `After=docker.service`.
  - 없으면(Docker Desktop): 의존을 쓰지 않고, 시작 직전에 `agent-wbs wait-docker 180`이 docker가 응답할 때까지 최대 180초 기다린다.
- Docker Desktop의 제약: Windows에 로그인해 Docker Desktop이 떠야 docker가 산다. 그래서 「PC를 켜면 아무도 로그인하지 않아도 자동 시작」은 보장할 수 없다.
  - Docker Desktop 설정 「Start Docker Desktop when you sign in」을 켠다.
  - 부팅 때 docker를 180초 안에 못 만나면 서비스는 실패로 남는다. Docker Desktop이 뜬 뒤 `sudo systemctl start agent-wbs.service`를 다시 한다.
  - WSL 안에 Docker Engine을 새로 설치하면 이 제약이 사라지지만, 지금 볼륨이 Docker Desktop 쪽에 있어 백업→복원 이전이 필요하다(owner 결정 O-3).

### 3.2 서비스 파일(초안, Docker Desktop판)

```ini
[Unit]
Description=Agent WBS server (docker compose: postgres, migrate, web, api, worker)
Documentation=file:///opt/agent-wbs/current/docs/ops/operations.md
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/agent-wbs/current
ExecStartPre=/opt/agent-wbs/bin/agent-wbs wait-docker 180
ExecStartPre=/opt/agent-wbs/bin/agent-wbs preflight
ExecStart=/opt/agent-wbs/bin/agent-wbs start
ExecReload=/opt/agent-wbs/bin/agent-wbs reload
ExecStop=/opt/agent-wbs/bin/agent-wbs stop
# 시작이 실패·시간 초과·중단으로 끝났고, 이번 실행에서 up을 시도했을 때만 정리한다(3판, 리뷰2 P1-1)
ExecStopPost=/opt/agent-wbs/bin/agent-wbs after-start
# 시도 표식을 두는 곳. 서비스가 시작할 때마다 새로 만들고 멈추면 지운다(/run/agent-wbs)
RuntimeDirectory=agent-wbs
RuntimeDirectoryMode=0700
TimeoutStartSec=300
TimeoutStopSec=150

[Install]
WantedBy=multi-user.target
```

- `agent-wbs start|reload|stop`이 부르는 compose 명령(고정 앞부분 `docker compose -p awbs-prod -f /opt/agent-wbs/current/deploy/compose.prod.yaml --env-file /opt/agent-wbs/etc/agent-wbs.env`):
  - `start`: `up`을 부르기 **직전에** 시도 표식 `$RUNTIME_DIRECTORY/up-attempted`를 만들고 `up -d --wait --wait-timeout 240 --remove-orphans`를 부른다. 실패하면 원래 실패 코드로 끝난다. 정리는 직접 하지 않고 아래 `after-start`에 맡긴다.
  - `after-start`(`ExecStopPost`): 시도 표식이 있고 systemd가 넘겨 주는 `$SERVICE_RESULT`가 `success`가 아닐 때만 `down --timeout 30`. 정리 `down`이 실패하면 「컨테이너가 남았을 수 있음」을 출력하고 0이 아닌 코드로 끝난다. 그 밖(표식 없음 = preflight 실패, 결과 success = 정상 stop)에는 아무것도 하지 않는다.
  - `reload`: `up -d --wait …`. 실패해도 `down`하지 않는다(이미 돌던 서비스를 업그레이드 실패 때문에 내리지 않는다). 실패 코드만 돌려주고 되돌리기 명령을 안내한다.
  - `stop`: `down --timeout 30`. docker가 응답하지 않거나 `down`이 실패하면 **0이 아닌 코드**로 끝난다(멈추지 못한 것을 「멈춤 성공」으로 보이지 않게).
- **왜 이렇게 하나(리뷰 P1-2, 리뷰2 P1-1)**: compose가 postgres·web 등을 만든 뒤 migrate나 헬스체크에서 실패하면 `ExecStart`가 실패한다. systemd는 **시작에 성공하지 못한 서비스에는 `ExecStop`을 실행하지 않는다.** 컨테이너는 docker가 가지고 있으므로 그대로 남는다.
  - 2판은 래퍼 안에서 `up` 실패를 받아 `down`했다. 그러나 **시작 시간 초과(`TimeoutStartSec`)나 시작 중 `stop`**이면 systemd가 래퍼를 강제로 끝내 그 줄까지 가지 못한다. 리뷰2가 그대로 재현했다(이 PC에서도 재현, 부록 A-3).
  - `ExecStopPost`는 시작이 어떻게 끝났든(실패·시간 초과·신호) 항상 실행된다. 그래서 정리를 여기로 옮겼다.
  - 그냥 `ExecStopPost=down`으로 두지 않는 이유: preflight 실패(예: 이미지 없음)에도 돌아, 이미 떠 있던 스택을 이유 없이 내린다. **이번 실행에서 `up`을 시도했다는 표식**이 있을 때만 정리한다. 표식은 `RuntimeDirectory` 안에 있어 서비스가 시작할 때마다 비워진다. 예전 실행의 표식이 남아 있을 수 없다.
  - 이 PC 시험(사용자 transient 유닛, 가짜 compose, 부록 A-3):

    | 경우 | 결과 | 자원 |
    | --- | --- | --- |
    | 2판 래퍼 + `up` 멈춤 → 시간 초과 | failed(timeout) | **남음**(리뷰2 재현) |
    | 3판 + `up` 멈춤 → 시간 초과 | failed(timeout), `after-start`가 `result=timeout`으로 down | 없음 |
    | 3판 + `up` 실패 | failed(exit-code) | 없음 |
    | 3판 + 시작 중 `systemctl stop` | failed(signal), `after-start`가 down | 없음 |
    | 3판 + preflight 실패, 이미 떠 있던 스택 | failed(exit-code), down 안 함 | **기존 스택 그대로** |
    | 3판 + 정상 시작 → stop | inactive(success), `ExecStop`이 down, `after-start`는 아무것도 안 함 | 없음 |

  - 남는 경우: `after-start` 자체가 `TimeoutStopSec`(150초) 안에 끝나지 못하거나 docker가 응답하지 않으면 정리를 장담할 수 없다. 이때는 0이 아닌 코드와 「남았을 수 있음」 메시지로 알리고, `agent-wbs status`가 남은 컨테이너를 보여 준다. 실제 compose로 이 경로를 시험하는 것은 구현 확인 목록 T-2.
- `systemd-analyze verify` 통과(임시 폴더에 만든 파일로, 부록 B). `docker.service` 의존판은 이 PC에서 예상대로 실패.
- 실행 계정: **root**(서비스 파일에 `User=`를 쓰지 않음).
  - 왜: docker를 부를 수 있는 계정은 사실상 root와 같다(docker 그룹 = root). root로 돌리고 비밀·compose 파일을 root 소유로 두는 편이 「누가 무엇을 고칠 수 있나」가 단순하다.
- `Type=oneshot` + `RemainAfterExit=yes`
  - `docker compose up -d`는 컨테이너를 띄우고 바로 끝난다. 상주 프로그램은 dockerd(Docker Desktop)다.
  - 그래서 「명령이 성공하면 서비스는 켜진 것으로 본다」는 형식이 맞다. `--wait`가 헬스체크 통과까지 기다리므로, `start`가 성공했다는 것은 **화면→nginx→api→DB까지 정상**이라는 뜻이다.
- `--project-name awbs-prod`와 볼륨 이름은 지금 그대로 둔다. 왜: 지금 운영 데이터를 옮기지 않고 이어 쓴다.
- `ExecStop`은 `down`(컨테이너·네트워크 삭제, **볼륨은 남김**, `-v`를 쓰지 않는다).
  - 왜 `stop`이 아닌가: 남아 있는 멈춘 컨테이너가 없어야 다음 `start`가 늘 같은 설정으로 새로 만든다.
  - compose의 `restart: unless-stopped`는 남긴다. 컨테이너 하나가 죽으면 docker가 다시 띄운다. `down` 뒤에는 컨테이너가 없으므로 docker가 몰래 다시 띄우는 일도 없다.
- 시간: 시작 300초(첫 migrate·헬스체크 여유), 멈춤 150초(컨테이너마다 `stop_grace_period` 30초).

### 3.3 명령별 동작

| 명령 | 하는 일 | 데이터 |
| --- | --- | --- |
| `systemctl start` | docker 기다림 → preflight → `up -d --wait`(migrate 먼저, 성공해야 api·worker). `up` 뒤 실패·시간 초과·시작 중 stop이면 `after-start`가 `down`으로 정리하고 failed | 유지 |
| `systemctl stop` | `down --timeout 30`(api·worker에 종료 신호 → 30초 뒤 강제). docker가 없거나 실패하면 stop도 실패로 표시 | 유지(볼륨 남김) |
| `systemctl restart` | stop 다음 start. 모든 컨테이너를 새로 만든다 | 유지 |
| `systemctl reload` | `up -d --wait`. 바뀐 컨테이너만 새로 만든다(업그레이드·설정 변경) | 유지 |
| `systemctl status` | 마지막 start/stop 결과와 출력 몇 줄. 컨테이너 개별 상태는 `agent-wbs status` | — |
| `systemctl enable/disable` | 부팅 때 자동 시작 켜기/끄기(install.sh가 enable까지 해 둔다) | — |

`preflight`가 보는 것(하나라도 틀리면 시작하지 않는다)

- `etc/agent-wbs.env`에 `AWBS_IMAGE_TAG`가 있고 두 이미지가 이 PC에 있다.
- 비밀 3개와 인증서 7개(키 3개 포함)가 있고 주인·권한이 2.2와 같다. 값은 읽지 않는다.
- 인증서가 CA로 검증되고 키 짝이 맞는다. 만료 30일 전이면 경고, 지났으면 시작 거부.
  - 왜 거부하나: 만료된 인증서로 뜨면 브라우저·Runner가 모두 접속을 거부한다. 「켜졌는데 아무도 못 붙는」 상태보다 원인이 보이는 실패가 낫다.
- 포트(기본 8443)를 다른 프로그램이 쓰지 않는다.

알아 둘 한계

- `systemctl status`가 active라는 것은 「마지막 start가 성공했다」는 뜻이다. oneshot 서비스는 그 뒤 Docker Desktop이 꺼지거나 컨테이너가 죽는 것을 감시하지 않는다. 실제 상태는 `agent-wbs status`(헬스체크 포함)로 본다.
- `down`의 30초 뒤 강제 종료는 진행 중인 요청을 끊을 수 있다. 볼륨은 남지만 「모든 일이 정상 완료됐다」는 뜻은 아니다. 그래서 계획된 멈춤 전에는 Runner를 먼저 멈춘다(6.1). PostgreSQL은 강제 종료 뒤에도 WAL로 복구한다. 이것은 리허설에서 한 번 확인한다(W2).
- Docker Desktop이 180초 안에 뜨지 않아 실패한 서비스는 나중에 Docker Desktop이 떠도 **스스로 다시 시작하지 않는다.** owner가 `sudo systemctl start agent-wbs.service`를 다시 한다(이를 받아들일지는 O-13).
  - `Restart=on-failure`를 넣는 방법도 있지만 시작 한도(`StartLimitBurst`)와 Docker Desktop 기동 시간을 함께 맞춰야 해서 이번에는 넣지 않는다.

### 3.4 로그 보는 법

- 서비스 자체(시작·멈춤 성공/실패): `journalctl -u agent-wbs.service -e`
- 컨테이너 로그: `sudo /opt/agent-wbs/bin/agent-wbs logs api -f`
- 컨테이너 로그를 journald로 보내는 방법(`logging: driver: journald`)은 쓰지 않는다.
  - 왜: Docker Desktop의 dockerd는 WSL 밖 가상 머신에서 돌아 WSL의 journald에 쓸 수 없다. 지금처럼 docker 기본 로그를 `agent-wbs logs`로 본다.

## 4. Runner 서비스 `agent-wbs-runner.service`

### 4.1 결정: 시스템 서비스로 바꾸되, 실행 계정은 keeproll 그대로

```ini
[Unit]
Description=Agent WBS Runner
Wants=user@1000.service network-online.target
After=user@1000.service network-online.target agent-wbs.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=keeproll
Group=keeproll
WorkingDirectory=/opt/agent-runner/current
Environment=PATH=/opt/agent-runner/runtime/current/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/keeproll
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=NODE_ENV=production
Environment=AWBS_AGENT_USER=awbs-agent
EnvironmentFile=/opt/agent-runner/etc/runner.env
LoadCredential=runner-token:/opt/agent-runner/etc/secrets/runner-token
# node가 뜨기 전에 지운다. node 안에서 지우면 이미 늦다(5.5)
UnsetEnvironment=NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
# 옛 사용자 서비스 awbs-runner.service가 켜져 있으면 거부, runtime의 node·npm·pnpm 확인(4.3)
ExecStartPre=/opt/agent-runner/bin/agent-wbs-runner preflight
ExecStart=/opt/agent-runner/runtime/current/bin/node src/main.ts
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=60
Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=multi-user.target
```

- `systemd-analyze verify` 통과(부록 B). 1000·keeproll은 install.sh가 `SUDO_USER`에서 채운다.
- `After=agent-wbs.service`는 순서만 정한다(`Requires`가 아님). 서버를 멈춰도 Runner는 멈추지 않고, 서버가 돌아오면 다시 붙는다.

### 4.2 지금 격리 구조가 시스템 서비스에서도 그대로 되는가

| 항목 | 지금(사용자 서비스) | 시스템 서비스(User=keeproll) | 판단 |
| --- | --- | --- | --- |
| sudo 래퍼 `sudo -n -u awbs-agent -- /usr/local/libexec/awbs-agent-exec` | keeproll로 실행 | 같은 keeproll. sudoers 한 줄 그대로 맞는다 | 그대로 됨 |
| `NoNewPrivileges` | 일부러 끔 | 끈 채로 둔다(켜면 sudo가 막힘) | 그대로 |
| `systemd-run --user --scope` (Agent를 Runner 소유 cgroup에 가두기) | Runner가 `user@1000.service` 안에 있음 | Runner는 `system.slice` 안. 사용자 systemd가 scope를 만들고 프로세스를 옮긴다 | 된다(아래) |
| `XDG_RUNTIME_DIR` | 사용자 systemd가 넣어 줌 | 서비스 파일에 `/run/user/1000`을 적는다. Runner 코드도 scope 실행 때 같은 값을 직접 넣는다(`exec/scope.ts` `scopeEnv`) | 됨 |
| linger | 필수 | **여전히 필수.** scope를 만드는 주체가 keeproll의 사용자 systemd(`user@1000.service`)이기 때문 | 유지 |
| scope 위치 | `user@1000.service/app.slice/awbs-<uuid>.scope` | 같음(만드는 쪽이 같다) | Runner 코드 변경 없음 |
| 서비스를 멈출 때 Agent 세션 | 별도 scope라 같이 안 끊김, Runner가 정리 | 같음 | 그대로 |

**scope 이동 확인(이 PC 실측)**

- cgroup v2 규칙상, root 소유 cgroup에 있는 프로세스를 사용자 cgroup으로 옮기려면 공통 조상 cgroup에 쓰기 권한이 필요하다. 사용자 systemd에는 그 권한이 없다.
- 그래도 된다: 사용자 systemd가 직접 못 옮기면 시스템 systemd(PID 1)에 대신 옮겨 달라고 요청한다(같은 사용자 프로세스일 때만 허용).
- 이 PC에서 root 소유 cgroup(`/non-systemd`)에 있는 셸에서 실행해 확인했다.

  ```text
  $ cat /proc/self/cgroup
  0::/non-systemd
  $ XDG_RUNTIME_DIR=/run/user/1000 systemd-run --user --scope --quiet --collect --slice=app.slice --unit=awbs-design-probe-<pid> -- cat /proc/self/cgroup
  0::/user.slice/user-1000.slice/user@1000.service/app.slice/awbs-design-probe-<pid>.scope
  exit=0
  ```

- 남은 확인: 실제 시스템 서비스(`system.slice`)에서의 실행은 sudo가 필요해 이번에 하지 못했다. 구현 작업의 첫 확인 항목으로 둔다(6장 W3).
  - 실패하더라도 위험하지 않다. Runner는 실행 전마다 scope 시험(`exec/scope.ts`의 확인 실행)을 하고, 실패하면 Agent 실행을 **거부**한다(isolation §5, app.ts `selectIsolation`).

**넣지 않는 보안 옵션과 이유**

- `ProtectSystem=strict`, `ProtectHome=`, `PrivateTmp=` 같은 격리 옵션은 넣지 않는다.
  - 왜: `systemd-run --scope`는 cgroup만 옮기고 **마운트 공간은 Runner 것을 물려받는다.** 이 옵션들을 켜면 Agent 세션(`/home/awbs-agent`, `/srv/agentwbs`)과 git·docker 작업까지 막혀 격리 설계(isolation §3)가 깨진다.
  - `systemd-analyze security` 점수는 9.0(UNSAFE)으로 나온다. 지금 사용자 서비스와 같은 수준이며, Agent 격리는 전용 계정·래퍼·scope가 맡는다.

### 4.3 설치 · 옛 서비스에서 넘어오기

`sudo bash install.sh --prefix=/opt`가 서버와 Runner를 함께 설치한다(`--only=server`, `--only=runner`로 하나만).

Runner 설치 단계

1. 점검: linger 켜짐, Agent 전용 계정 확인(`check-agent-user.sh`, FAIL 0개), node 26.13 이상, 서버 CA 파일.
2. `runtime/node` 복사, `releases/<커밋>/`에 소스+운영 의존성(keeproll로 `pnpm install --prod --frozen-lockfile`을 임시 폴더에서 한 뒤 root 소유로 복사).
3. `etc/runner.env` 만들기(없을 때만). 옛 `agent-runner/.env`가 있으면 **비밀이 아닌 줄만** 옮긴다(`AWBS_GITHUB_MODE`, `AWBS_GITHUB_REPO`, `AWBS_ATTEMPT_AUTO`, `AWBS_CI_AUTO` 등). `AWBS_URL`은 새 https 주소로 쓴다.
4. 토큰: 4.5.
5. 옛 사용자 서비스 정리: `awbs-runner.service`(사용자 서비스)를 `disable --now`하고, 서비스 파일은 **지우지 않고** `<P>/agent-runner/var/legacy/<옛 커밋>/`에 옛 Runner 복구본(코드·의존성·옛 node)과 함께 보관한다(6.1 3-1). 옛 `agent-runner/.env`는 지우지 않는다.
   - 왜 보관하나: 이행을 되돌릴 때(6.1) 옛 Runner를 다시 띄워야 한다. 서비스 파일만으로는 부족하고 옛 코드·의존성·node까지 있어야 한다(리뷰2 P1-4). 되돌리기 기한(O-12)이 지나면 uninstall.sh가 지운다.
   - 두 Runner가 동시에 켜지지 않게: 새 서비스는 시작 전 점검(`ExecStartPre`)에서 사용자 서비스 `awbs-runner.service`가 active면 시작을 거부한다. 되돌리기 쪽도 새 시스템 서비스가 active면 옛 것을 켜지 않는다.
   - 왜 옛 것을 끄나: 두 Runner가 같은 데이터 폴더를 쓰면 안 된다. 데이터 폴더 잠금이 막아 주지만, 하나가 계속 실패·재시작하며 로그를 쌓는다.
6. 서비스 파일 설치·`enable`. 시작은 하지 않는다.

**Agent 전용 계정 설치(`setup-agent-user.sh`)와의 관계**

- install.sh는 전용 계정을 **만들지 않는다.** 확인만 하고, 없으면 정확한 설치 명령을 보여 주고 멈춘다.
  - 왜: 계정 생성·sudoers·`/srv/agentwbs` 권한은 이 PC의 보안 경계를 바꾸는 일이라 따로 확인하며 하는 것이 맞다(isolation §2). 이 PC에는 이미 설치돼 있다(`/usr/local/libexec/awbs-agent-exec`, root 소유 확인).
  - 한 번에 하고 싶다면 `--with-agent-user`로 설치기 안에서 부르게 할 수 있다(owner 결정 O-5).

### 4.4 Runner 토큰 보관: 환경 변수 대신 systemd 자격 증명

- 지금: 토큰이 `agent-runner/.env`에 있고 `node --env-file`로 **환경 변수**가 된다.
- 바뀐 뒤: `LoadCredential=runner-token:…`으로 systemd가 서비스 시작 때 `/run/credentials/agent-wbs-runner.service/runner-token`(서비스 계정만 읽는 메모리 폴더)에 넣어 준다. Runner는 `$CREDENTIALS_DIRECTORY/runner-token` 파일에서 읽는다.
  - 왜: 환경 변수는 Runner가 띄우는 모든 자식 프로세스(git·gh·docker·pnpm)에 그대로 물려진다. 파일로 두면 그런 일이 없다. sudo가 Agent 쪽 환경을 지우는 것(isolation §5.1)과 별도로 한 겹 더 막는다.
  - 원본 파일은 `root 0600`이라 keeproll도 직접 못 읽고, 서비스 실행 중에만 읽을 수 있다.
- Runner 코드 변경: `AWBS_RUNNER_TOKEN_FILE`(또는 `CREDENTIALS_DIRECTORY`)에서 읽기. 환경 변수 `AWBS_RUNNER_TOKEN`은 개발·시험용으로 남긴다.

### 4.5 Runner 토큰 발급·승인을 설치기가 어디까지 하나

결정: **같은 PC에 서버와 Runner를 함께 설치할 때는 install.sh가 끝까지 자동으로 한다.** 사람이 토큰을 보거나 복사하지 않는다.

1. Runner 서비스가 켜져 있으면 멈춘다(데이터 폴더 잠금 때문에).
2. keeproll로 `runner:public-key <임시 공개키 파일>` → Runner ID(상태 파일의 실제 ID, operations §5.1.1).
3. 서버가 켜져 있어야 한다. 꺼져 있으면 「서버를 먼저 시작한 뒤 `sudo /opt/agent-wbs/bin/agent-wbs runner-enroll`을 실행하세요」를 보여 주고 이 단계만 건너뛴다.
4. `agent-wbs runner-token <ID> <공개키>` 출력(토큰)을 **화면이 아닌** 임시 파일(root 0600)에 받고, 형식(32자 이상 출력 가능 문자)을 확인한 뒤 `etc/secrets/runner-token`으로 `mv`(원자적 교체)한다.
5. 토큰 파일이 이미 있으면 아무것도 하지 않는다. 다시 발급은 `runner-enroll --reissue`(install.sh에서는 `--reissue-runner-token`)일 때만 한다.
   - 순서는 **새 토큰 발급·저장이 먼저, 옛 토큰 폐기가 나중**이다. 새 토큰 저장이 실패하면 옛 토큰을 그대로 두고 멈춘다. 왜: 순서가 반대면 새 토큰을 못 만든 채 옛 토큰만 잃어 Runner가 아예 붙지 못한다(리뷰 P1-5).
   - 폐기 대상은 「바꾸기 직전 `etc/secrets/runner-token`에 있던 값」 하나다. 그 값을 `revoke-runner`의 표준 입력으로만 넘긴다(화면·인자에 쓰지 않음).
   - 이행 때(6.1)는 옛 `agent-runner/.env`의 토큰을 폐기 대상으로 준다(`runner-enroll --reissue --revoke-from-env <옛 .env>`). 새 설치에는 토큰 파일이 아직 없으므로 「있으면 건너뜀」 규칙과 충돌하지 않는다.

- 「승인」은 owner가 sudo로 install.sh를 실행한 것으로 본다. 화면에서 따로 승인하는 단계는 지금 없고, 새로 만들지 않는다.
- Runner를 다른 PC에 둘 때는 자동으로 할 수 없다(서버 컨테이너에 닿을 수 없음). 그때는 지금처럼 owner가 서버 쪽에서 발급하고 파일로 옮긴다(별도 절차, 이번 범위 밖).

## 5. 전 구간 TLS

### 5.1 통신 경로 전부와 결정

| # | 경로 | 지금 | 결정 | 인증서 검증 |
| --- | --- | --- | --- | --- |
| A | Windows 브라우저 → web(nginx) | http 127.0.0.1:5173 | **https 127.0.0.1:8443**, TLS 1.2·1.3, http/2 | 브라우저가 Windows 신뢰 저장소의 사설 CA로 검증 |
| A' | (http 포트) | — | **열지 않는다.** http→https 전환(redirect)도 두지 않는다 | — |
| B | web(nginx) → api: `/api/`, **`/health`, `/health/db`** (세 location 모두) | http 127.0.0.1:3100 | **https 127.0.0.1:3100**, TLS 1.3만(api 쪽 `minVersion: TLSv1.3`) | nginx `proxy_ssl_verify on`, CA 고정, 이름 `api`. 세 location이 같은 설정 파일을 `include`(5.3) |
| C | api·worker·migrate → postgres | 평문 TCP | **TLS 1.3만**, `sslmode=verify-full` | CA 고정, 이름 `postgres`. pg_hba로 TLS 아닌 TCP 접속 거부 |
| D | Runner → 서버(web 경유 /api) | http 127.0.0.1:5173 | **https 127.0.0.1:8443** | Runner가 **우리 CA만** 믿는다(CA 고정). 검증 끄는 설정은 만들지 않는다 |
| E1 | Runner·git·gh → GitHub(https 원격·API), CLI 설치 → npm, Agent CLI → Claude·Codex 서버 | https | 그대로(공인 인증서, 시스템 CA) | 시스템 CA. git `http.sslVerify=false` 같은 설정 금지를 확인 항목에 넣는다 |
| E2 | Runner의 GitHub API 주소 바꾸기(`AWBS_GITHUB_API_URL`) | 코드가 **production에서도 `http://`를 허용**(`config.ts`) | production에서는 `https://`만 허용. `http://` fake는 시험 설정에서만(W4) | 시스템 CA |
| E3 | Runner의 **시스템 직접 push**(`git/repository.ts`: `ssh://git@ssh.github.com:443/<owner>/<repo>.git`) | **SSH**(443 포트지만 TLS가 아님) | **TLS가 아닌 암호화 통신으로 남는다.** 서버 키는 `knownHosts` 파일로 검증한다(코드가 파일 존재를 확인). owner가 예외로 허용할지, https push로 바꿀지 결정(O-10) | SSH 서버 키(known_hosts) |
| E4 | 설치·업그레이드 때 내려받기: docker 기반 이미지, apt(Playwright 시스템 라이브러리), npm·pnpm, Playwright Chromium, node 배포본 | apt만 **http**(기반 이미지 기본값) | 모두 https. apt는 CA 묶음을 먼저 넣고 https로 바꾼다(2.5) | 시스템 CA(apt), node 내장 CA(npm·Playwright), registry TLS(docker) |
| F1 | worker·api → SMTP | 설정값에 따름(`SSL/TLS`·`STARTTLS`·`없음`) | **`없음`(평문) 금지.** 저장·연결 확인·발송에서 서버가 거부. `STARTTLS`는 처음 인사·협상이 평문이고 로그인·본문 전에 TLS를 강제한다(`requireTLS`). 「첫 바이트부터 TLS」로 해석하면 `SSL/TLS`만 허용(O-10) | 공인 인증서 검증(nodemailer 기본 켜짐) |
| F2 | api → Telegram | 지금 코드는 `http://127.0.0.1` 시험 서버만 부른다(아래 주의) | 실제 연결은 `https://api.telegram.org` 고정 | 시스템 CA |
| G | Runner ↔ sudo 래퍼, Runner ↔ 사용자 systemd(D-Bus), backup·restore의 `docker exec psql`(유닉스 소켓), **postgres 헬스체크(바꾼 뒤: `pg_isready`를 `-h` 없이, 유닉스 소켓)** | 네트워크 아님(헬스체크는 지금 `-h 127.0.0.1` TCP) | **해당 없음**(같은 PC 안의 프로세스 실행·유닉스 소켓). postgres 헬스체크에서 `-h 127.0.0.1`을 뺀다 | — |
| H | api 안의 PDF용 Chromium | 페이지를 `https://report.awbs.invalid`로 열지만 모든 요청을 코드가 가로채 응답 | **해당 없음**(네트워크로 나가지 않음, `pdf/render.ts`) | — |
| I | 헬스체크: web `curl https://127.0.0.1:8443/health/db`(nginx→api→DB 한 번에), api `node fetch https://127.0.0.1:3100/health/db` | http | https + `--cacert /run/secrets/ca_crt` / api 컨테이너에서만 `NODE_EXTRA_CA_CERTS`로 같은 CA 검증 | 검증함(`-k` 금지) |
| J | 복원 리허설·`agent-wbs status`·owner의 확인 `curl` | http | https + `--cacert <prefix>/agent-wbs/share/ca.crt` | 검증함 |

**발견한 문제(이번 설계 범위 밖, 따로 보고)**

- F2: `apps/api/src/notify/bot.ts`는 `AWBS_TELEGRAM_BOT_API_URL`이 `http://127.0.0.1`일 때만 연결한다(「Q-16 결정 전에는 fake 서버에만」 주석). 운영 compose에는 이 값이 없다. 그래서 **지금 운영에서 Telegram 「봇 확인」·발송은 실제 Telegram에 닿지 않고 항상 network 실패**가 된다. operations §6.3 안내와 맞지 않는다. TLS 작업과 함께 `https://api.telegram.org`만 허용하도록 고치는 것을 제안한다(W5).
- LAN 모드: 운영 구성에서는 api가 nginx 뒤에 있어 **모든 요청의 소켓 주소가 127.0.0.1**로 보인다. 그대로 LAN을 켜면 ① 1회용 로그인 링크의 「같은 PC에서만」 검사가 LAN 사용자에게도 통과하고 ② PIN 시도 제한(주소별 60초 5회)이 모든 사용자를 한 주소로 센다. 그래서 **이번 설계에서도 운영 LAN 모드는 켜지 않는 것을 기본으로 한다.** LAN이 필요하면 「nginx가 실제 주소를 api에 안전하게 전달하는 방법」을 따로 설계한다(owner 결정 O-4).

### 5.2 브라우저 → web (A)

nginx 설정(초안)

```nginx
server {
    listen 8443 ssl;
    http2 on;
    server_tokens off;
    ssl_certificate     /run/secrets/web_crt;
    ssl_certificate_key /run/secrets/web_key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;
    # 보안 헤더(5.6)
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'" always;
    location /api/ {
        proxy_pass https://127.0.0.1:3100;
        include /etc/nginx/awbs/api-upstream.conf;
        # 나머지(Host·Connection·timeout·buffering)는 지금 설정 그대로
    }
    # 헬스체크 경로도 반드시 같은 upstream TLS 설정을 쓴다(리뷰 P1-3).
    location = /health    { proxy_pass https://127.0.0.1:3100; include /etc/nginx/awbs/api-upstream.conf; }
    location = /health/db { proxy_pass https://127.0.0.1:3100; include /etc/nginx/awbs/api-upstream.conf; }
    # 화면 경로(location /, /index.html, /assets/)는 지금 설정 그대로
}
```

`/etc/nginx/awbs/api-upstream.conf`(이미지에 넣는 새 파일)

```nginx
proxy_ssl_verify on;
proxy_ssl_verify_depth 1;
proxy_ssl_trusted_certificate /run/secrets/ca_crt;
proxy_ssl_name api;
proxy_ssl_server_name on;
proxy_ssl_protocols TLSv1.3;
```

- 왜 파일 하나로 묶나: 지금 nginx 설정에는 `/api/` 말고도 `location = /health`, `location = /health/db`가 **따로** 있고 각자 `proxy_pass http://…`를 가진다. api만 https로 바꾸고 이 둘을 빠뜨리면, 헬스체크가 평문으로 TLS 포트를 두드려 실패한다. 반대로 둘을 지우면 `/health/db` 요청이 화면 파일(`index.html`)로 떨어져 **DB가 죽어도 200**이 나온다. 세 location이 같은 `include`를 쓰면 하나만 빠뜨리는 실수가 없다.
- 확인(부록 A-2): `/health`·`/health/db`·`/api/x` 셋 다 api가 만든 JSON을 https upstream으로 받았고, web 컨테이너 헬스체크 명령(`curl --cacert … https://127.0.0.1:8443/health/db`)도 성공했다. 평문으로 api에 닿는 경로는 실패(000)했다.
- 인수 조건(W1): nginx 설정의 `proxy_pass http://` 줄 수 0, `proxy_pass https://` 줄마다 `include …/api-upstream.conf`가 붙어 있음.

- 포트 안의 포트: 컨테이너 안 8443을 호스트 `127.0.0.1:${AWBS_WEB_PORT:-8443}`에 연다. 지금처럼 127.0.0.1에만 연다.
- 평문 http로 8443에 접속하면 nginx가 `400`(「HTTPS 포트에 평문 요청」)으로 답한다. 다른 동작은 없다(부록 A에서 확인).
- 왜 http 포트를 열지 않나: 열어 두면 브라우저 주소창에 `http://`로 들어간 첫 요청이 평문으로 나간다. 같은 PC 안이라도 「평문 통로가 없다」가 가장 단순하고 확실하다. 즐겨찾기만 https로 바꾸면 된다.

### 5.3 nginx → api (B)

- api(fastify)가 `https`로 듣는다: 새 환경 변수 `AWBS_TLS_CERT_FILE`, `AWBS_TLS_KEY_FILE`(값은 compose secrets 경로). TLS 최소 버전은 `minVersion: 'TLSv1.3'`.
  - 확인(부록 A-2): `minVersion: TLSv1.3` 서버에 TLS 1.2로 붙으면 거부(curl exit 35), TLS 1.3은 200.
  - 운영(`NODE_ENV=production`)에서는 이 둘이 없으면 api가 **시작을 거부**한다. 왜: 설정 하나 빠뜨려 평문으로 뜨는 일을 막는다.
  - 개발(`pnpm dev`, vite)은 지금처럼 http를 허용한다. 개발 구성은 이번 지시 대상(운영 설치)이 아니다(owner 결정 O-6).
- **이 PC에서 찾은 함정**: nginx는 위 쪽(upstream) 인증서를 **IP 주소로 검증하지 못한다.** `proxy_ssl_name 127.0.0.1`로 두면 인증서에 `IP:127.0.0.1`이 있어도 `upstream SSL certificate does not match "127.0.0.1"`로 502가 난다(부록 A 1차 시험).
  - 그래서 api 인증서에 DNS 이름 `api`를 넣고 `proxy_ssl_name api`로 검증한다. 접속 자체는 `127.0.0.1:3100`으로 하고, 이름은 검증에만 쓴다(DNS 조회 없음).
  - api 인증서에는 `IP:127.0.0.1`도 넣는다. api 컨테이너 헬스체크(`node fetch https://127.0.0.1:3100/health/db`)가 IP로 검증하기 때문이다.
- 이름이 틀리면 nginx가 502로 막는 것을 음성 시험으로 확인했다(부록 A).

### 5.4 api·worker·migrate → postgres (C)

postgres 설정

```text
command: postgres -c track_commit_timestamp=on -c ssl=on
         -c ssl_cert_file=/run/secrets/db_crt -c ssl_key_file=/run/secrets/db_key
         -c ssl_min_protocol_version=TLSv1.3 -c hba_file=/etc/awbs/pg_hba.conf
user: "999:999"        # 2.2.1 그룹 방식을 쓰려면 root로 시작하지 않아야 한다(아래)
group_add: ["${AWBS_SECRET_GID}"]
```

pg_hba.conf(새 파일, `releases/<커밋>/deploy/pg_hba.conf`)

```text
local   all all              trust          # 컨테이너 안 유닉스 소켓(backup·restore의 docker exec). 지금 이미지 기본값과 같다
hostssl all all 0.0.0.0/0    scram-sha-256
hostssl all all ::/0         scram-sha-256
host    all all 0.0.0.0/0    reject         # TLS가 아닌 TCP 접속은 거부
host    all all ::/0         reject
```

- postgres 헬스체크: 지금은 `pg_isready -h 127.0.0.1`(TCP)이다. **`-h`를 빼서 유닉스 소켓으로 검사한다.** 왜: pg_hba가 TLS 아닌 TCP를 거부하는 구성에서 TCP 검사를 그대로 두면 「소켓이라 해당 없음」이라는 설명이 거짓이 된다. 소켓 검사는 네트워크를 쓰지 않는다. 확인(부록 A-2): `user 999` + hostssl 전용 구성에서 소켓 헬스체크 `healthy`, 같은 컨테이너의 `127.0.0.1` 평문 TCP는 `no encryption`으로 거부.
- 앱 쪽: `app-entrypoint.sh`의 `db_url()`이 주소 끝에 `?sslmode=verify-full&sslrootcert=/run/secrets/ca_crt`를 붙인다. node-postgres(`pg`)가 이 두 값을 읽는다(앱 이미지 안의 `pg`로 확인, 부록 A).
- 왜 `user: "999:999"`인가: postgres 이미지는 root로 시작한 뒤 `gosu`로 postgres 계정으로 바뀌는데, 이때 `group_add`로 붙인 추가 그룹이 사라질 수 있다. 처음부터 999로 띄우면 추가 그룹이 남는다. 기존 볼륨의 DB 파일은 이미 999 소유라 그대로 열린다.
  - postgres는 키 파일이 「DB 계정 소유 0600」 또는 「root 소유 0640 이하」일 때만 받는다. `root:awbs-secret 0640`은 두 번째 조건에 맞는다.
- 검증(부록 A): `verify-full` 성공(TLSv1.3), 이름이 다른 별명(`db`)으로 접속하면 `ERR_TLS_CERT_ALTNAME_INVALID`로 거부, `sslmode=disable`은 pg_hba가 `no encryption`으로 거부, `docker exec` 유닉스 소켓은 그대로 됨.
- 구현 때 확인할 것: 지금 운영 볼륨(`awbs-prod-pgdata`)을 `user: 999:999`로 띄우는 것은 복원 리허설로 확인한다(이번 시험은 새 빈 DB로 했다).

### 5.5 Runner → 서버 (D): CA 고정

- `AWBS_URL=https://127.0.0.1:8443`, `AWBS_CA_FILE=/opt/agent-runner/etc/ca.crt`(Runner를 설치하면 install.sh가 `share/ca.crt`와 같은 파일을 여기 복사한다. 서버만 설치한 PC에는 이 경로가 없다).
- Runner의 서버 호출은 이미 `createApiClient({ fetch })`로 fetch를 바꿔 끼울 수 있다(`agent-runner/src/api/client.ts`). 서버 호출에만 「우리 CA만 믿는」 fetch를 넣는다.
  - 방법: `https.request`/undici `Agent`의 `ca` 옵션에 `AWBS_CA_FILE`만 준다. 이러면 시스템의 공인 CA로 서명된 인증서도 서버로 인정하지 않는다(= CA 고정).
  - 이 PC에서 `https.request({ ca })`로 시스템 CA 없이 연결되는 것을 확인했다(부록 A).
  - **주의(리뷰 확인)**: node 기본 `fetch`의 요청 옵션에 `{ ca }`를 넣는 것은 **동작하지 않는다**(무시된다). `https.request` 기반 어댑터나 undici `Agent`(dispatcher)를 실제로 만들어야 한다. 그래서 W4는 「한 줄 수정」이 아니라 어댑터 구현 + 시험이다.
- W4 인수 조건(실제 `createApiClient`에 넣은 상태로 시험)
  - 요청 전에 실패해야 하는 것: production에서 `http://` 주소, CA 파일 없음·읽기 실패·PEM 형식 오류, 검증 끄기 환경(`NODE_TLS_REJECT_UNAUTHORIZED`), **`NODE_EXTRA_CA_CERTS`가 있는 환경**(지우고 진행하지 않는다).
  - 성공: 올바른 CA·이름. 실패: 다른 CA, 다른 이름, 만료 인증서, 평문 서버.
  - 지금 client의 동작을 그대로 지킨다: 수동 redirect(토큰이 다른 주소로 새지 않게), timeout·AbortSignal, FormData 증거 업로드, Response 처리.
  - GitHub 호출(fetch)에는 사설 CA가 섞이지 않는다(GitHub 쪽은 공인 CA만, 사설 CA로 만든 가짜 github 인증서는 거부).
- GitHub API 호출(`github/client.ts`)은 지금처럼 기본 fetch(시스템 CA)를 쓴다. 우리 CA를 GitHub 쪽에 섞지 않는다.
- `NODE_EXTRA_CA_CERTS`는 Runner에 쓰지 않는다. **production에서 환경에 이 값이 있으면 요청을 하나도 보내기 전에 시작을 거부한다.**
  - 2판의 「경고하고 지운 뒤 진행」은 틀렸다(리뷰2 P1-2). node는 이 변수를 **프로세스 시작 때 한 번** 읽어 신뢰 목록에 넣는다. 나중에 `delete process.env.NODE_EXTRA_CA_CERTS`를 해도 자식에게 넘길 값만 없어지고, 이미 들어간 CA는 그대로다. 리뷰2 실측: 지운 뒤에도 추가 CA 수 1→1, 기본 fetch가 사설 CA 서버에 200.
  - 이중 장치: 서비스 파일에 `UnsetEnvironment=NODE_EXTRA_CA_CERTS`를 넣어 node가 뜨기 전에 systemd가 지운다. `runner.env`에 이 줄이 있으면 Runner preflight(`agent-wbs-runner preflight`)가 거부한다. 그래도 들어오면 Runner 코드가 시작을 거부한다(시험 T-9).
  - 왜: 이 변수는 「시스템 CA + 우리 CA」를 **모든** 연결에서 믿게 만든다. 고정이 아니고, Runner가 띄우는 자식 node 프로세스에도 물려진다.
- 설정 검사(Runner `config.ts`): `NODE_ENV=production`이면 `AWBS_URL`이 `https:`가 아니거나 `AWBS_CA_FILE`이 없을 때 시작을 거부한다. `rejectUnauthorized: false`·`NODE_TLS_REJECT_UNAUTHORIZED=0` 같은 「검증 끄기」 설정은 만들지 않고, 환경에 `NODE_TLS_REJECT_UNAUTHORIZED`가 있으면 시작을 거부한다.

### 5.6 HSTS · 쿠키 · Origin · CSRF · 보안 헤더

- **HSTS(브라우저에게 「앞으로 이 주소는 https로만」이라고 기억시키는 헤더)는 보내지 않는다.**
  - 왜 1: 브라우저는 IP 주소(127.0.0.1)에 대한 HSTS를 무시한다(RFC 6797). 효과가 없다.
  - 왜 2: `localhost`로 들어온 요청에 HSTS를 주면 **포트와 상관없이** localhost 전체에 적용된다. 그러면 개발용 `http://localhost:5173`(vite)이 브라우저에서 막힌다.
  - http 포트를 아예 열지 않으므로 HSTS가 막으려는 「첫 평문 요청」 문제도 없다.
- **쿠키**: 세션 쿠키를 `__Host-awbs_session; Path=/; Secure; HttpOnly; SameSite=Strict`로 바꾼다.
  - 지금은 로그인 요청의 Origin 헤더가 https일 때만 `Secure`를 붙인다(`platform/security.ts`). 설정(`AWBS_ORIGIN`)이 https면 **항상** 붙이도록 바꾼다. 왜: 요청 헤더에 따라 보안 속성이 달라지면 안 된다.
  - `__Host-` 접두어: 브라우저가 「Secure·Path=/·Domain 없음」일 때만 저장하는 이름 규칙이다. 다른 경로·하위 도메인이 같은 쿠키를 덮어쓰지 못한다.
  - 이름이 바뀌므로 배포 뒤 한 번 다시 로그인한다.
- **Origin 검사**: `AWBS_ORIGIN=https://127.0.0.1:8443`(compose가 포트로 만든다). 브라우저 주소와 다르면 변경 요청이 `FORBIDDEN_PRINCIPAL`로 거부되는 규칙은 그대로다.
  - `localhost`로 접속하면 Origin이 달라 변경 요청이 거부된다. 주소는 `https://127.0.0.1:8443` 하나로 안내한다(지금과 같은 규칙).
  - LAN용 같은 PC 주소 목록(`security.ts`의 `localOrigins`)과 LAN 로그인 링크 주소(`auth-cli.ts`)가 `http://`로 박혀 있다. `https://`로 바꾼다.
- **CSRF**: 지금 규칙(세션별 `x-csrf-token` + Origin + `SameSite=Strict`) 그대로. TLS로 바뀌어도 달라지지 않는다.
- **보안 헤더**(5.2의 nginx 설정): `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`, CSP.
  - CSP(화면이 불러올 수 있는 자원을 정하는 헤더)는 화면 전체 e2e 시험으로 깨지는 곳이 없는지 확인한 뒤 켠다. 깨지면 먼저 `Content-Security-Policy-Report-Only`로 시작한다.
- **「접속 주소」 설정**: 화면 설정 → 알림 → 「Agent WBS 접속 주소」를 `https://127.0.0.1:8443`으로 owner가 바꾼다. 메일·Telegram 링크가 이 값으로 만들어진다. DB 구조는 바뀌지 않는다(migration 없음).

### 5.7 LAN 모드(PIN)일 때

- 기본은 지금처럼 **LAN 꺼짐**이다. 5.1 「발견한 문제」 때문에 LAN을 켜기 전에 별도 설계가 필요하다.
- 나중에 켤 때 인증서 준비: owner-cert.md의 명령에 `LAN_IP=<Windows PC의 LAN IP>`(필요하면 `LAN_HOST=<이름>`)를 붙여 **web 인증서만 다시** 만든다.
  - CA의 이름 제약(5.8)에 사설 IP 대역(10/8, 172.16/12, 192.168/16)은 미리 넣어 두었다. 그래서 LAN IP는 CA를 새로 만들지 않고 추가할 수 있다. 호스트 이름은 CA를 만들 때 `LAN_HOST`를 줘야 들어간다.
  - WSL2는 Windows 뒤의 내부 망에 있다. LAN에서 닿으려면 Windows 쪽 포트 전달과 방화벽 설정이 따로 필요하다(그때 설계).
- LAN에서 접속하는 다른 PC에도 CA를 등록해야 경고 없이 열린다.

### 5.8 사설 인증서 설계

owner가 만들 파일(명령은 owner-cert.md, 이 PC 임시 폴더에서 실행해 검증함)

| 파일 | 내용 | 어디에 쓰나 | 권한(설치 뒤) |
| --- | --- | --- | --- |
| `ca-offline/ca.key` | 사설 CA 개인키 | 서명할 때만. **설치하지 않는다.** USB·암호 관리자에 따로 보관하고 PC에서는 지운다 | owner 보관 |
| `ca.crt` / `ca.cer` | 사설 CA 인증서(PEM / Windows용 DER, 같은 내용) | 브라우저(Windows), nginx·api·postgres 검증, Runner | 0644(공개) |
| `web.crt` / `web.key` | 서버 인증서: `IP:127.0.0.1`, `DNS:localhost` (+LAN) | nginx(A) | key `root:awbs-secret 0640` |
| `api.crt` / `api.key` | 서버 인증서: `DNS:api`, `IP:127.0.0.1` | api(B) | 〃 |
| `db.crt` / `db.key` | 서버 인증서: `DNS:postgres` | postgres(C) | 〃 |

결정과 이유

- **CA 하나 + 서버 인증서 셋**으로 나눈다.
  - 왜 나누나: 키가 들어가는 컨테이너가 다르다. api가 뚫려도 nginx 키(브라우저가 보는 인증서)는 api 컨테이너에 없다. 셋으로 나눠도 owner가 하는 일은 명령 한 칸으로 같다.
- **키 종류: ECDSA P-256.** Windows의 Chrome·Edge, nginx, node, postgres가 모두 지원하고, RSA보다 짧고 빠르다.
- **유효 기간**: CA 10년(3650일), 서버 인증서 397일.
  - 왜 397일: 공인 인증서의 브라우저 상한(398일) 안이다. 사설 CA는 이 상한이 없지만, 1년마다 갱신하는 습관이 키 노출 기간을 줄인다. `preflight`가 30일 전부터 경고한다.
- **CA 이름 제약(nameConstraints)**: 이 CA는 `localhost`, `api`, `postgres`, `127.0.0.0/8`, 사설 IP 대역(10/8·172.16/12·192.168/16)에만 인증서를 낼 수 있다.
  - 왜: Windows 신뢰 저장소에 넣은 CA는 원래 **어느 사이트 인증서든** 만들 수 있다. CA 키가 새면 은행 사이트도 위장할 수 있다는 뜻이다. 이름 제약을 넣으면 키가 새도 그 이름 밖에는 못 쓴다.
  - 확인: 같은 CA로 `example.com`·`8.8.8.8` 인증서를 억지로 만들면 OpenSSL(= curl·node·postgres가 쓰는 검증)에서 `permitted subtree violation`으로 실패한다(부록 A).
  - **한계(정직하게)**: Windows 쪽은 확인하지 못했다. 신뢰 저장소에 넣지 않은 상태의 Windows 검사(PowerShell `X509Chain`)는 위반 인증서도 `UntrustedRoot`만 표시했고 이름 제약 위반을 따로 표시하지 않았다(부록 A). Windows 브라우저가 등록된 사설 CA의 이름 제약을 지키는지는 실제 등록 뒤에만 확인할 수 있다.
  - 그래서 이름 제약은 **보조 장치**로 본다. 주된 방어는 「CA 키를 PC 밖에 보관」(O-9)이다.
- **서버 인증서 확장**: `CA:FALSE`, `keyUsage=digitalSignature`, `extendedKeyUsage=serverAuth`, `subjectAltName`(위 표). 이름은 CN이 아니라 SAN으로만 검증된다.
- **파일 주인**: 2.2.1(전용 그룹). 컨테이너 uid(1000·101·999)에 맞추지 않는다.
- **CA 키는 서명 뒤 따로 보관**: install.sh는 `ca-offline/`을 복사하지 않는다. 갱신할 때만 꺼내 쓴다.
- **WSL 쪽 신뢰**
  - Runner: `AWBS_CA_FILE`(CA 고정, 5.5). 시스템 저장소에 넣지 않아도 된다.
  - 컨테이너 헬스체크: `curl --cacert /run/secrets/ca_crt`, api는 `NODE_EXTRA_CA_CERTS=/run/secrets/ca_crt`(api 컨테이너 안에서만).
  - owner가 WSL에서 `curl`로 확인할 때: `curl --cacert /opt/agent-wbs/share/ca.crt https://127.0.0.1:8443/health/db`. `agent-wbs status`도 같은 방법으로 확인한다.
    - `etc/tls/ca.crt`를 쓰면 안 된다. 파일은 0644여도 상위 폴더 `etc/tls/`(0750, 비밀 그룹)를 사람 계정이 통과하지 못해 `Permission denied`가 난다(리뷰 P2-10). 그래서 공개 사본 `share/ca.crt`를 둔다.
  - WSL 시스템 전체에 넣는 방법(`/usr/local/share/ca-certificates` + `update-ca-certificates`)은 쓰지 않는다. 왜: 이 PC의 모든 프로그램(Agent 포함)이 이 CA를 믿게 되는데, 그럴 필요가 없다.

### 5.9 인증서 갱신·교체(약 1년마다)

**왜 「파일만 바꾸고 reload」로는 안 되나(리뷰 P2-9)**

- compose의 파일 secret은 bind mount(호스트 파일을 컨테이너에 그대로 연결)다. 호스트에서 파일을 새 파일로 원자적 교체(`mv`)하면 **실행 중인 컨테이너는 옛 파일(옛 inode)을 계속 본다.** 리뷰에서 「호스트=새 내용, 컨테이너=옛 내용」을 직접 재현했다.
- 파일 경로와 이미지가 같으면 `compose up`(= `reload`)은 컨테이너를 새로 만들지 않을 수 있다.
- 그래서 만료일만 새로워지고 실제 서버는 옛 인증서를 계속 내밀다가 만료 날 끊긴다.

**갱신 절차(같은 CA로 서버 인증서 셋만 새로)** — `agent-wbs renew-cert <새 폴더>`가 한 번에 한다(W2).

1. owner: CA 키를 보관 장소에서 꺼내 owner-cert.md 6단계 칸으로 새 폴더(`~/awbs-tls-renew-<날짜>/`)에 web·api·db를 만든다. 칸이 CA 키·CA 인증서 짝, 세 장의 CA 검증, 키 짝, SAN, 기간을 확인한다(이 PC에서 검증함).
2. `sudo agent-wbs renew-cert <새 폴더>`
   1. 새 파일 점검: `share/ca.crt`로 검증, 키 짝, SAN(web: 127.0.0.1·localhost, api: api·127.0.0.1, db: postgres), 남은 기간 300일 이상. **CA의 남은 기간도 300일 이상**이어야 한다(`openssl x509 -checkend 25920000`). 실제로 쓸 수 있는 기간은 leaf와 CA 중 **먼저 끝나는 쪽**이기 때문이다(리뷰2 P2-6). 부족하면 「CA 교체 절차」를 안내하고 멈춘다.
   - 이 명령은 **같은 CA**의 갱신 전용이다. 다른 CA로 만든 파일은 거부한다(정상). CA를 바꿀 때는 아래 `replace-ca`를 쓴다.
   2. 지금 파일을 `var/tls-old/<시각>/`에 복사해 보관.
   3. 새 파일을 `etc/tls/`에 같은 주인·권한으로 원자적 교체.
   4. **`systemctl restart agent-wbs.service`**(전체 down→up). web만 다시 만들지 않는다. 왜: api가 web의 네트워크 공간을 같이 쓰므로 web만 새로 뜨면 api 네트워크가 끊긴다(operations §8). 수십 초의 중단을 받아들인다(O-11).
   5. 실제로 내미는 인증서 확인: web은 `openssl s_client -connect 127.0.0.1:8443`, api는 web 컨테이너 안에서 `127.0.0.1:3100`(이름 `api`), db는 `openssl s_client -starttls postgres`로 **일련번호가 새 파일과 같은지** 본다.
   6. 하나라도 실패하면 `var/tls-old/<시각>/`을 되돌려 놓고 다시 restart한 뒤 실패로 끝낸다.
3. owner: CA 키를 보관 장소로 돌려놓고 PC 사본을 지운다.

- Runner·Windows는 할 일 없음(CA가 같으므로).

**만료 경고**

- owner-cert.md 6단계 칸도 서명 **전에** CA가 397일 이상 남았는지(`-checkend 34300800`) 보고, 모자라면 폴더를 만들기 전에 멈춘다(이 PC에서 만료 5일 남은 CA로 거부 확인, 부록 A-3).
- `agent-wbs-certcheck.timer`(매일 1회)가 `agent-wbs certcheck`를 부른다. 서버 인증서 셋과 CA 중 **가장 먼저 끝나는 날짜**를 기준으로 남은 기간이 30일 아래면 journal에 경고(`journalctl -u agent-wbs-certcheck`)를 남기고, `agent-wbs status`와 서비스 시작 로그에도 표시한다.
  - 왜 타이머인가: 서비스가 397일 내내 켜져 있으면 시작 때의 preflight 경고는 한 번도 안 보인다.
  - 화면 알림·Telegram으로도 알릴지는 O-11.

**CA 자체를 바꿀 때(10년 뒤 또는 CA 키 분실·노출)** — 별도 명령 `replace-ca`(리뷰2 P1-3)

2판은 이 경우도 `renew-cert`로 하게 했는데, 두 가지로 깨졌다. ① `renew-cert`는 새 파일을 **지금 CA**로 검증하므로 새 CA의 인증서를 당연히 거부한다. ② Windows 삭제 명령이 이름(`*Agent WBS Local CA*`)으로 찾아서 **옛 CA와 새 CA를 둘 다** 지운다. 그래서 따로 나눈다.

순서(계획된 교체 — 옛 CA가 아직 안전할 때). 옛 CA와 새 CA를 잠깐 **함께** 믿게 둔 채 넘어가서 끊김이 없다.

1. owner: owner-cert.md 2단계 칸의 `OUT=`만 새 폴더(예: `$HOME/awbs-tls-2036`)로 바꿔 새 CA와 서버 인증서 셋을 만든다. 출력의 새 지문을 적어 둔다. **옛 CA의 지문도 적어 둔다**(옛 2단계 기록 파일에 있다).
2. owner: Windows에 새 CA를 등록한다(owner-cert.md 3-2 칸, 새 지문). 이때 옛 CA는 지우지 않는다.
3. `sudo agent-wbs replace-ca <새 폴더> --new-thumbprint <새 지문> --old-thumbprint <옛 지문>`
   1. 새 CA 점검: 자기 서명, `CA:TRUE`, 이름 제약 있음, 지문이 `--new-thumbprint`와 같음, 남은 기간 5년 이상.
   2. 서버 인증서 셋을 **새 CA로** 검증(키 짝·SAN·기간).
   3. 지금 파일을 `var/tls-old/<시각>/`에 보관(옛 CA 포함).
   4. `etc/tls/`(ca 포함)·`share/ca.crt`·(Runner가 있으면) `/opt/agent-runner/etc/ca.crt`를 함께 교체.
   5. 서버 `restart` → Runner `restart`.
   6. 새 CA로 실제 접속 확인: web·api·db의 내미는 인증서가 새 CA 체인으로 검증되는지(`openssl s_client -CAfile share/ca.crt`), Runner heartbeat가 다시 들어오는지.
   7. 하나라도 실패하면 3번 보관본으로 되돌리고 restart 두 번, 실패로 끝낸다. Windows는 두 CA를 다 믿고 있으므로 되돌려도 브라우저가 끊기지 않는다.
4. owner: 브라우저로 `https://127.0.0.1:8443` 접속(새 CA 체인)을 확인한 **뒤에** Windows에서 옛 CA를 **지문 하나로만** 지운다(owner-cert.md 3-3 칸). 이름으로 찾아 지우지 않는다.
5. owner: 옛 CA 키를 보관 장소에서 폐기하고, 새 CA 키를 보관한다(owner-cert.md 5단계).

키 노출이 의심될 때(사고). 옛 CA를 믿는 시간을 줄이는 것이 먼저다.

1. owner: Windows에서 옛 CA를 **지문으로 즉시** 지운다(3-3). 이때부터 브라우저는 서버를 믿지 않는다(경고) — 받아들인다.
2. 위 1~3번(새 CA 만들기·등록·`replace-ca`)을 바로 한다. `replace-ca`의 확인은 같다.
3. 옛 CA로 서명했을 수 있는 다른 파일이 이 PC나 백업에 있으면 지운다. 이름 제약 때문에 노출된 키로 만들 수 있는 인증서는 `localhost`·`api`·`postgres`·사설 IP 이름뿐이지만, Windows가 이를 지키는지 확인하지 못했으므로(5.8) 지체하지 않는다.

## 6. 이행

### 6.1 지금 운영에서 넘어가는 순서(데이터 옮김 없음)

지금 이 PC에는 `awbs-prod` 운영이 실제로 떠 있다(컨테이너 4개, `127.0.0.1:5173`).

**가. 준비(옛 운영을 켜 둔 채로)** — 오래 걸리는 일과 실패하기 쉬운 일을 중단 전에 끝낸다.

1. owner: 인증서 만들기(owner-cert.md 2단계) → Windows에 CA 등록(3단계).
2. 복원 리허설(현재 판 TLS, 2.6)을 통과시킨다. 기존 볼륨을 `user 999:999`로 여는지 여기서 확인된다.
3. `sudo bash install.sh --prefix=/opt --prepare`
   - 하는 일: 점검, 그룹, `etc/`(옛 비밀 **복사**, 하나라도 없거나 형식이 틀리면 멈춤), 인증서 복사, 이미지 빌드, `releases/`, Runner runtime(node·npm·pnpm)과 같은 PATH의 준비 점검, 서비스 파일 **검증만**(`systemd-analyze verify`).
   - 하지 않는 일: 서비스 설치·enable, 옛 운영·옛 Runner 멈추기, 토큰.
   - 실패하면 옛 운영은 그대로다. 고친 뒤 같은 명령을 다시 하면 된다(두 번 실행 안전).
   - **새 판은 원래 저장소가 아니라 별도 폴더에서 실행한다**: `git -C /home/keeproll/projects/agent-wbs worktree add /home/keeproll/awbs-release-<새 커밋> <새 커밋>` 뒤 그 폴더의 `install.sh`. 원래 저장소(`/home/keeproll/projects/agent-wbs`)는 옛 커밋 그대로 둔다. 왜: 옛 사용자 서비스는 원래 저장소의 파일을 그대로 실행한다. 이행 중에 원래 저장소를 새 판으로 바꾸면 되돌릴 코드가 사라진다.
3-1. 같은 `--prepare`가 **옛 Runner 복구본**을 만든다(리뷰2 P1-4). 서비스 파일만 남겨서는 되돌릴 수 없다. 옛 유닛은 `WorkingDirectory=<저장소>/agent-runner`, `ExecStart=<nvm node> … src/main.ts`로 그 순간의 저장소 파일을 실행하기 때문이다. 새 W4 코드는 production에서 http를 거부하므로, 새 코드로 옛 http 서버에 붙는 「되돌리기」는 성공할 수 없다.
   - 대상 커밋: 옛 사용자 서비스 파일의 `WorkingDirectory`가 가리키는 저장소의 `HEAD`. 그 저장소의 `agent-runner/`에 커밋하지 않은 변경이 있으면 멈춘다(복구본이 실제로 돌던 코드와 달라지므로).
   - 만드는 것: `<P>/agent-runner/var/legacy/<옛 커밋>/`
     - `agent-runner/`: `git archive <옛 커밋> agent-runner`로 꺼낸 소스 + 그 커밋의 lockfile로 설치한 운영 의존성(`pnpm install --prod --frozen-lockfile`, 옛 node로)
     - `node/`: 옛 서비스 파일의 `@NODE@`가 가리키는 node 배포본(nvm 버전 폴더) 통째. 옛 상태 그대로가 목적이라 2.3의 「nvm 통째 복사 금지」와 달리 그대로 복사한다. 새 서비스는 이것을 쓰지 않는다.
     - `awbs-runner.service`: 옛 서비스 파일을 `WorkingDirectory=…/legacy/<옛 커밋>/agent-runner`, `ExecStart=…/legacy/<옛 커밋>/node/bin/node --env-file=<옛 .env 경로> src/main.ts`, `PATH=…/legacy/<옛 커밋>/node/bin:…`로 바꾼 판. `systemd-analyze --user verify` 통과해야 한다.
     - `MANIFEST`: 옛 커밋, 옛 node 버전, 파일 sha256 목록, 옛 서버 이미지 꼬리표(`~/.agentwbs/prod/deploy.env`), 옛 compose 파일 경로.
   - 복구본 점검(`--prepare` 안에서): 복구본 node로 `node --version`, 복구본 위치에서 Runner 설정 점검만 하는 무과금 명령(서버에 붙지 않음)이 통과해야 한다. 실패하면 `--activate`를 거부한다(되돌릴 수단 없이 전환하지 않는다).
   - 옛 서버 쪽 보관: 옛 이미지 `awbs-app:<옛 꼬리표>`·`awbs-web:<옛 꼬리표>`는 O-12 기한까지 지우지 않는다. 옛 compose 파일(`<원래 저장소>/agent-wbs/deploy/compose.prod.yaml`, 옛 커밋)도 `var/legacy/<옛 커밋>/server/`에 복사해 둔다.

**나. 전환(여기서부터 중단)**

4. 열린 일 정리: 옛 Runner를 멈추고(`systemctl --user stop awbs-runner.service`) `… exec -T api awbs-entrypoint auth jobs open`으로 `leased`·`started`·`reconcile`이 없는지 본다(operations §4.4의 1~2단계와 같은 기준). 남아 있으면 옛 Runner를 다시 켜서 끝내게 한 뒤 다시 멈춘다.
5. 백업: `bash <저장소>/agent-wbs/deploy/backup.sh`.
   - 주의: backup.sh는 끝날 때 api·worker를 **다시 켠다.** 그래서 백업 뒤 6번까지 사이에 화면에서 바꾼 내용은 이 백업에 없다. 이 사이에는 화면을 쓰지 않는다. 되돌리기에서 DB를 복원하면 복원 시점은 이 백업이다.
6. 옛 서버 멈춤: `docker compose -p awbs-prod -f … --env-file ~/.agentwbs/prod/deploy.env down`(**`-v` 없이**. 볼륨은 남는다). 이것으로 옛 http 5173 리스너도 없어진다.
7. `sudo bash install.sh --prefix=/opt --activate` — 3-1의 복구본 점검이 통과했는지 다시 보고, 서비스 파일 설치·enable, 옛 Runner 사용자 서비스 `disable`(원래 사용자 서비스 파일도 `var/legacy/<옛 커밋>/awbs-runner.service.orig`로 보관).
8. `sudo systemctl start agent-wbs.service` → `curl --cacert /opt/agent-wbs/share/ca.crt https://127.0.0.1:8443/health/db` → 브라우저로 `https://127.0.0.1:8443` → 다시 로그인(쿠키 이름이 바뀜).
9. `sudo /opt/agent-wbs/bin/agent-wbs runner-enroll --reissue --revoke-from-env /home/keeproll/projects/agent-wbs/agent-runner/.env`
   - 새 토큰 발급·저장이 먼저, 옛 `.env` 토큰 폐기가 나중(4.5). 새 토큰 저장이 실패하면 옛 토큰은 살아 있다.
10. `sudo systemctl start agent-wbs-runner.service` → 화면의 Runner 상태·heartbeat 확인.
11. 화면 설정의 「접속 주소」를 `https://127.0.0.1:8443`으로 바꾼다.
12. 되돌리기 기한(O-12)이 지나면 owner가 옛 `~/.agentwbs/prod/secrets`, `var/legacy/<옛 커밋>/`, 옛 이미지를 정리한다(설치기는 지우지 않는다). 원래 저장소도 그때 새 판으로 바꿔도 된다.

**되돌리기(이행 전 http 방식으로)** — `sudo /opt/agent-wbs/bin/agent-wbs legacy-rollback`이 아래를 순서대로 한다(W3). 폐기한 옛 토큰을 다시 살리지는 않는다. 옛 Runner용으로 **새 토큰**을 발급한다.

1. 새 Runner 서비스 `stop`·`disable`(Runner 먼저. 두 Runner가 동시에 켜지지 않게).
2. 새 서버 서비스 `stop`·`disable`. `stop`이 실패하면(컨테이너가 남음) 여기서 멈추고 알린다.
3. 옛 compose(`var/legacy/<옛 커밋>/server/compose.prod.yaml`)로 `up -d --wait`(옛 꼬리표·옛 `deploy.env`·옛 비밀 그대로). 옛 이미지가 없으면 멈춘다. 새 판이 마이그레이션을 실행했으면 이 대신 5번 백업을 옛 이미지로 복원한다(operations §7.2, 2.6의 「이행 전 HTTP 이미지 복원」).
4. **복구본을 가리키는** `var/legacy/<옛 커밋>/awbs-runner.service`를 `~/.config/systemd/user/awbs-runner.service`로 놓고 keeproll의 `systemctl --user daemon-reload`. 복구본의 `MANIFEST` sha256이 맞지 않으면 멈춘다. 원래 저장소가 지금 어떤 커밋이든 상관없다.
5. 옛 `agent-runner/.env`의 `AWBS_URL`이 `http://127.0.0.1:5173`인지 확인(값만 보고 바꾸지 않음. 다르면 멈춤).
6. 옛 Runner용 새 토큰: Runner ID로 `… exec -T api awbs-entrypoint auth runner-token` → 출력을 화면이 아닌 임시 파일로 받아, `.env`의 `AWBS_RUNNER_TOKEN` 줄만 바꾼 새 `.env`(0600)를 만들어 `mv`. 그 뒤 새 시스템 서비스가 쓰던 토큰(`etc/secrets/runner-token`)을 폐기.
7. `systemctl --user start awbs-runner.service` → heartbeat 확인.

**되돌리기가 끝났다고 보는 조건**(O-12): `http://127.0.0.1:5173/health/db` 정상, 로그인됨, 옛 Runner heartbeat 정상, 새 서비스 둘 다 inactive·disabled, `awbs-prod` 컨테이너가 한 벌뿐, Runner 프로세스가 하나뿐.

### 6.2 문서·명령서 대체 범위

| 문서 | 처리 |
| --- | --- |
| `docs/ops/operations.md` | §0·§2·§3.1·§4·§5·§8을 새 방식으로 다시 쓴다. §1(구성 요소)·§6(SMTP·Telegram)·§7(백업 원리)은 경로·주소만 바꾼다 |
| `docs/ops/M8-06-real-env-record.md` | 기록이므로 고치지 않는다. 맨 위에 「이 문서의 명령은 install.sh 이전 방식」 안내 한 줄 |
| `agent-runner/docs/OWNER-RUNBOOK.md` | Runner 서비스 단계(사용자 서비스)를 새 서비스로 바꾼다. 전용 계정 설치 단계는 그대로 |
| `agent-runner/deploy/install-runner-service.sh`, `awbs-runner.service.in` | 옛 서비스 **제거용**으로만 남기고(`--uninstall`), 설치는 install.sh로 넘긴다. 한 판 뒤에 지운다 |
| `agent-wbs/deploy/prod-init.sh`, `set-image.sh` | install.sh 안으로 들어간다. 파일은 개발·리허설용으로 남긴다 |
| `agent-wbs/deploy/restore-rehearsal.sh` | 주소·Origin·`curl --cacert`·Runner CA·`seed-demo`의 CA secret을 https 판으로 바꾼다. 「현재 판 TLS 복원」과 「이행 전 HTTP 이미지 복원」을 나눈다(2.6) |
| owner 명령서 `m8-prod/owner-run.md` | **새 명령서로 대체**: 0단계(점검) → 인증서(owner-cert.md) → `install.sh` → `systemctl start` → 로그인 → Runner 등록·시작 → 화면 확인. 지금의 2~5단계(빌드·set-image·compose up·Runner 사용자 서비스 설치·토큰 손 발급)가 명령 서너 개로 줄어든다 |

### 6.3 M8-04·M8-05와의 순서

- M8-04(CLI 실측)·M8-05(실제 흐름)는 운영 서버와 Runner가 떠 있어야 한다.
- 추천: **이번 설치·TLS 작업을 먼저 끝내고** M8-04·05를 새 방식에서 한다.
  - 왜: M8-05는 메일·Telegram 링크·GitHub 연결까지 실제로 확인한다. 주소가 http→https로 바뀌면 그 확인을 다시 해야 한다. 유료 호출 예산(30회)을 두 번 쓰지 않으려면 주소를 먼저 고정하는 편이 낫다.
  - M8-04(CLI 실측)는 주소와 관계가 적어 지금 방식에서 먼저 해도 된다. 다만 Runner 서비스가 바뀌는 사이에 실측 기록이 섞이지 않게, 하려면 이행 전에 끝낸다(owner 결정 O-7).
- Runner job 수신 연결 작업(다른 작업자, 미병합)과의 관계
  - 그 작업은 `agent-runner/src/app.ts`·`jobs/`·`planning/`을 주로 고친다. 이 설계가 Runner 코드에서 고치는 곳은 `config.ts`(https·CA·토큰 파일·GitHub API 주소 https만), `main.ts`의 `createApiClient` 연결부, 그리고 **새 파일**인 CA 고정 HTTPS 어댑터다. 어댑터는 새 파일이라 겹치지 않지만, 「한 줄 수정」은 아니다(5.5).
  - 겹침을 줄이려고 Runner 코드 변경(W4)은 **그 작업이 병합된 뒤** 시작한다. 서버·설치 쪽(W1~W3)은 지금 바로 시작할 수 있다.

### 6.4 구현 작업 나누기(제안)

| 묶음 | 내용 | 담당 | 먼저 끝나야 하는 것 | migration |
| --- | --- | --- | --- | --- |
| W1 서버 TLS | api https 듣기(`AWBS_TLS_*`, 운영에서 필수, TLS 1.3), Origin·쿠키(`__Host-`·Secure)·`localOrigins`·login-link https, entrypoint `sslmode=verify-full`, nginx 8443 TLS·`api-upstream.conf`를 `/api/`·`/health`·`/health/db`에 include·보안 헤더, postgres ssl·pg_hba·`user 999`·소켓 헬스체크, compose secrets·`group_add`, 헬스체크 https, **Dockerfile apt https(CA 묶음 먼저)**. 시험: 기존 단위·e2e + TLS 음성 시험(평문 거부·이름 불일치·CA 없음·TLS1.2 거부·`/health/db`가 DB 장애 때 실패) + `--no-cache` 빌드 로그 http 0줄 | codex | — | **없음** |
| W2 설치기 | `install.sh`(`--prepare`/`--activate`, 점검, 그룹, etc, 비밀 가져오기(빠지면 멈춤), 인증서·`share/ca.crt` 복사, 빌드, release·current, 서비스 파일, DrvFS prefix 거부), `bin/agent-wbs`(`start`=실패 시 down 정리, `stop`=실패 표시, `renew-cert`, `certcheck`+timer), `uninstall.sh`, 계약 변경 감지, **리허설 TLS화**(주소·Origin·CA·Runner CA·seed-demo CA secret, 두 종류 복원 시험). 시험: 임시 prefix·전용 프로젝트 이름으로 설치→두 번 실행→업그레이드→되돌리기→제거, 시작 실패 뒤 잔여 컨테이너 0, 인증서 교체 뒤 실제 제시 일련번호 확인 | claude | W1과 동시에 시작 가능(compose 파일은 W1이 고치고 W2는 경로만 받는다. 파일 소유를 먼저 나눈다) | 없음 |
| W3 Runner 서비스 | 시스템 서비스 파일, **runtime(node 공식 배포본+sha256, npm, pnpm 12.16.1 고정)과 같은 PATH의 준비 점검**, Runner 설치 단계·옛 사용자 서비스 보관·두 Runner 동시 실행 거부, 토큰 자동 등록(`runner-enroll`, 새 것 먼저·옛 것 나중), **옛 Runner 복구본(6.1 3-1)과 `legacy-rollback`**. **첫 확인: 실제 시스템 서비스에서 `systemd-run --user --scope`**(User·XDG_RUNTIME_DIR·linger·sudo 허용·scope cgroup 위치·kill 뒤 비었음·Runner 재시작 뒤 대조, owner sudo 필요) | claude | W2의 틀 | 없음 |
| W4 Runner TLS | `config.ts`(production에서 https·`AWBS_CA_FILE` 필수, `NODE_TLS_REJECT_UNAUTHORIZED`·`NODE_EXTRA_CA_CERTS`가 있으면 **시작 거부**(지우고 진행하지 않음), **`AWBS_GITHUB_API_URL` https만**(http fake는 시험 설정만)), **CA 고정 HTTPS 어댑터**(native fetch `{ca}`는 안 됨), `AWBS_RUNNER_TOKEN_FILE`/`CREDENTIALS_DIRECTORY`. 인수 조건은 5.5 목록 | codex | **Runner job 수신 작업 병합 뒤** | 없음 |
| W5 외부 TLS 정리 | SMTP `없음` 서버 거부(계약 enum은 유지, 저장·확인·발송 때 거부. 화면에서 선택지 비활성), O-10 결과에 따라 `STARTTLS` 처리, Telegram `https://api.telegram.org` 연결(fake는 시험 설정에서만), O-10 결과에 따라 시스템 SSH push 처리 | codex | O-10 답 | 없음(값 거부만, 표 구조 그대로) |
| W6 문서·명령서 | operations.md·OWNER-RUNBOOK 갱신, 새 owner 명령서(6.2, 준비/전환/되돌리기 칸 분리) | claude | W1~W4 | — |
| 교차 리뷰 | W1·W4·W5는 claude가, W2·W3·W6은 codex가 리뷰 | — | — | — |

- 예상 migration: **없음.** DB 표 구조를 바꾸는 작업이 없다. 「접속 주소」 값은 owner가 화면에서 바꾼다.
- 서버 계약(OpenAPI 경로·필드) 변경: 없음. 그래서 이번 배포는 operations §4.4(계약 변경 절차) 대상이 아니다. 단 SMTP `없음`을 화면에서 숨기는 것은 화면만의 변경이다.

## 7. owner가 정할 것

| ID | 질문 | 선택지 | 추천 |
| --- | --- | --- | --- |
| O-1 | 운영 https 포트 | (a) **8443** (b) 5173 유지 (c) 443 | **(a) 8443.** 개발 vite(5173)와 겹치지 않는다. 443은 Windows의 다른 프로그램과 겹치기 쉽다 |
| O-2 | 설정·비밀·백업 위치 | (a) **모두 `<prefix>/agent-wbs/` 안** (b) FHS식 `/etc/opt/agent-wbs`·`/var/opt/agent-wbs` | **(a)**. 지시(「지정한 디렉토리 아래로」)와 맞고 한 곳만 보면 된다 |
| O-3 | docker 종류 | (a) **Docker Desktop 유지**(로그인 뒤 자동 시작) (b) WSL 안에 Docker Engine 설치(로그인 없이 부팅 자동 시작, 볼륨 백업→복원 이전 필요) | **(a)** 지금은 유지. 무인 재부팅이 필요해지면 (b) |
| O-4 | 운영 LAN 모드 | (a) **꺼 둠**(127.0.0.1 전용) (b) 켬(별도 설계 먼저: 실제 주소 전달) | **(a)** |
| O-5 | Agent 전용 계정 설치 | (a) **install.sh는 확인만, 없으면 멈춤** (b) `--with-agent-user`로 함께 설치 | **(a)**. 이 PC에는 이미 설치됨 |
| O-6 | 개발 구성(`pnpm dev`, 개발 compose)도 https로 | (a) **이번에는 운영만** (b) 개발도 https(vite 인증서 설정) | **(a)**. 지시가 「설치·기동」 대상이고, 개발은 시험 도구(Playwright 등) 설정까지 바뀐다 |
| O-7 | M8-04 순서 | (a) **이행(설치·TLS) 뒤에 M8-04·05** (b) M8-04는 지금 방식에서 먼저 | **(a)** |
| O-8 | 서버 인증서 수 | (a) **3개(web·api·db)** (b) 1개를 셋이 같이 씀 | **(a)**. 명령은 같고 키 노출 범위가 줄어든다 |
| O-9 | CA 키 보관 | (a) **USB 등 PC 밖에 보관하고 PC에서 지움** (b) PC에 `0600`으로 둠 | **(a)**. Windows가 믿는 CA라 새면 피해가 크다(이름 제약이 있어도) |
| O-10 | 「모든 통신 TLS」의 예외를 둘지(리뷰 P2-11·STARTTLS) | ① GitHub 시스템 push: (a) **SSH(`ssh.github.com:443`, 서버 키 검증)를 「TLS 아닌 암호화 통신」 예외로 허용** (b) https push로 바꾼다(W5에서 push 방식·인증 재설계) ② SMTP: (a) **`SSL/TLS`·`STARTTLS`(로그인·본문 전 TLS 강제) 허용** (b) `SSL/TLS`(465처럼 첫 바이트부터 TLS)만 | ① **(a)**: 이미 암호화·서버 키 검증이 있고, 바꾸면 Q-09 보호 흐름의 push 경로를 다시 검증해야 한다. ② **(a)**: 많은 메일 서버(587)가 STARTTLS만 준다. 지시를 글자 그대로 「첫 바이트부터」로 보시면 둘 다 (b) |
| O-11 | 인증서 갱신 운영 | 경고: (a) **매일 timer → journal + `agent-wbs status`** (b) (a) + 화면 알림·Telegram. 교체 중단: (a) **전체 restart의 수십 초 중단 허용** (b) 무중단 교체 설계(별도 작업) | 경고 **(a)**(Telegram 실연결이 W5 뒤라서. 그 뒤 (b)로 넓힐 수 있음), 중단 **(a)** |
| O-12 | 이행 되돌리기 기한·완료 조건 | (a) **이행 뒤 7일 동안 옛 사용자 서비스 파일·옛 비밀을 보관, 6.1의 완료 조건으로 판정** (b) 이행이 확인되면 바로 정리 | **(a)** |
| O-13 | Docker Desktop 늦은 기동 | (a) **180초 안에 docker가 없으면 서비스는 failed로 두고 owner가 `systemctl start`를 다시 한다** (b) `Restart=on-failure`로 몇 번 더 자동 재시도(시작 한도 함께 설계) | **(a)**(O-3 (a)와 짝). 무인 복구가 필요하면 O-3 (b)가 근본 해결 |

추천은 그대로 두고, 리뷰에서 나온 보충만 적는다.

O-10~O-13은 **추천을 고르는 것만으로 승인되지 않는다.** 리뷰2가 붙인 조건을 함께 승인하는 것이다.

- O-10 (a)를 고르면: ① SSH push는 「TLS가 아닌 **암호화 예외**」로 owner가 **따로 명시 승인**한다. 조건: 지금 코드의 서버 키 확인(`ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<파일> -o GlobalKnownHostsFile=/dev/null`, `git/repository.ts`)을 그대로 유지한다(시험 T-14). ② STARTTLS는 「처음 인사·협상은 평문, 로그인·본문 전 TLS 강제」를 owner가 **따로 명시 승인**한다. 조건: `requireTLS`를 유지하고 인증서 검증을 끄지 않는다(시험 T-15). 승인 전에는 「모든 통신 TLS」를 다 채운 것으로 세지 않는다.
- O-11 (a)를 고르면: journal·`status` 경고는 owner가 **직접 봐야 하는 수동 확인**이다(알림이 오지 않는다). 이를 알고 고른다. 만료 판정은 leaf와 **CA 중 먼저 끝나는 날**로 한다(5.9).
- O-12 (a)를 고르면: 7일 동안 보관하는 것은 **옛 Runner 복구본(코드·운영 의존성·옛 node·서비스 파일), 옛 compose 파일, 옛 이미지 두 개, 옛 `deploy.env`, 옛 비밀**이다(6.1 3-1). 서비스 파일·비밀만으로는 7일이 「복구 보장 기간」이 되지 않는다. 기한 안에 원래 저장소를 새 판으로 바꿔도 되돌리기는 복구본으로 한다.
- O-13 (a)를 고르면: PC를 켠 뒤 **무인 자동 복구는 약속하지 않는다**는 뜻이다. 무인 부팅·복구가 필요하면 이 선택으로는 채울 수 없고 O-3 (b)가 필요하다.
- O-6: 추천 (a)가 표에 있다는 사실을 owner 승인으로 보지 않는다(리뷰2 재확인).

- O-2: prefix가 Windows 드라이브(`/mnt/<드라이브>`)면 리눅스 권한이 지켜지지 않아 install.sh가 거부한다(2.2).
- O-6: 원래 지시는 「모든 통신」이다. (a)를 고르시면 「개발 구성은 이번 범위에서 http 예외」를 owner가 **명시적으로 승인**하신 것으로 기록하고, 그 전에는 지시를 다 채운 것으로 세지 않는다.
- O-7: SMTP·Telegram 정리(W5)도 M8-05의 실제 알림 시험 전에 끝나야 한다.
- O-9: 일반 USB는 Windows 드라이브라 리눅스 권한 0600이 지켜지지 않는다. 암호 관리자 첨부 또는 암호화된 저장 장치(BitLocker To Go 등)를 쓰고, 보호를 확인하기 전에는 PC 원본을 지우지 않는다(owner-cert.md 5단계).

## 8. 구현 단계 확인 목록(W1~W6이 코드와 시험으로 증명할 것)

이 설계는 이번 판으로 닫는다. 아래는 문서·임시 시험으로는 끝까지 증명할 수 없어 **구현 작업자가 코드와 자동 시험(또는 기록을 남기는 실행 시험)으로 증명해야 하는 항목**이다. 각 W의 완료 보고에는 해당 T 번호의 시험 이름·명령·결과를 붙인다. 하나라도 통과하지 못하면 그 W는 끝나지 않은 것이다.

공통 규칙: 시험은 전용 이름(`awbs-t<번호>-*`)·임시 prefix·전용 포트로 한다. 운영(`awbs-prod`)·다른 프로젝트·`docker volume prune`·유료 CLI 호출은 쓰지 않는다. sudo가 필요한 시험(T-1 등)은 owner 명령서로 만들어 owner가 실행한다.

| ID | 담당 | 무엇을 증명하나 | 방법 | 통과 조건 |
| --- | --- | --- | --- | --- |
| T-1 | W3(owner sudo) | 시스템 서비스(`system.slice`, `User=keeproll`) 안에서 Agent 격리가 그대로 된다 | 시험용 시스템 유닛으로 Runner의 scope 확인 실행·sudo 래퍼 `check`·Agent 가짜 명령 하나 | scope가 `user@1000.service/app.slice/awbs-<uuid>.scope`에 생김, 래퍼가 awbs-agent로 실행, scope kill 뒤 비었음, Runner 재시작 뒤 대조 통과. 실패하면 Runner가 실행을 거부함(실행되면 안 됨) |
| T-2 | W2 | 시작 실패·**시간 초과**·시작 중 stop 뒤 잔여 컨테이너가 없다(3.2) | 실제 compose, 전용 project. migrate를 일부러 실패/헬스체크를 일부러 느리게(`TimeoutStartSec` 짧게)/시작 중 `systemctl stop` | 세 경우 모두 서비스 failed + 그 project 컨테이너 0개. preflight 실패 때 이미 떠 있던 같은 project는 그대로. docker를 멈춘 상태의 `after-start`는 0이 아닌 코드와 「남았을 수 있음」 |
| T-3 | W1·W2 | 기존 운영 볼륨을 `postgres user: 999:999`로 연다 | 현재 판 TLS 복원 리허설(2.6)로 운영 백업을 새 이름에 복원 후 기동 | 지문 대조 통과, `pg_stat_ssl`의 ssl=true |
| T-4 | W1 | 빌드에 평문 http 내려받기가 없다 | `--no-cache` 빌드 로그 검사, Dockerfile의 CA 묶음 COPY → `ca-certificates` 설치 | `http://`로 시작하는 내려받기 줄 0개, `ca-certificates` 설치 단계 정상 종료 |
| T-5 | W1 | 보안 헤더·CSP가 화면을 깨지 않는다 | e2e 전체(https) | 기존 e2e 모두 통과, 콘솔 CSP 위반 0건(깨지면 Report-Only로 시작하고 기록) |
| T-6 | W1 | nginx의 모든 api 경로가 TLS·검증을 쓴다 | 설정 정적 검사 + DB를 멈춘 상태의 `/health/db` | `proxy_pass http://` 0줄, 모든 `proxy_pass https://`에 `api-upstream.conf` include, DB 정지 때 `/health/db`가 200이 아님(화면 파일로 떨어지지 않음) |
| T-7 | W1 | 내부 TLS 음성 시험 | api에 TLS1.2, CA 없는 접속, 이름 불일치, postgres `sslmode=disable`, 평문 TCP | 모두 거부. 소켓 헬스체크는 healthy |
| T-8 | W4 | Runner CA 고정 어댑터 | 5.5의 인수 조건 목록 전체를 실제 `createApiClient`로 | 목록 전부 통과. GitHub fetch에 사설 CA가 섞이지 않음 |
| T-9 | W4·W3 | `NODE_EXTRA_CA_CERTS`·`NODE_TLS_REJECT_UNAUTHORIZED`가 있으면 시작 거부 | 그 변수를 넣고 Runner 실행, 시험 서버로 요청이 오는지 관찰. `runner.env`에 그 줄을 넣고 preflight | 종료 코드 0 아님, 시험 서버에 요청 0건, preflight 거부. 서비스 파일에 `UnsetEnvironment` 있음 |
| T-10 | W3 | runtime이 완전하다 | 공식 tarball sha256 불일치 주입, 오프라인 tarball 경로, 서비스 PATH로 `node`·`npm`·`npx`·`pnpm` | 불일치 거부, 두 경로 모두 네 도구가 runtime 안에서 찾아짐, Runner 준비 점검 통과 |
| T-11 | W2 | 같은 CA 갱신(`renew-cert`) | 갱신 칸으로 만든 파일로 교체, 일부러 잘못된 키로 한 번 | 교체 뒤 web·api·db가 **내미는** 일련번호가 새 것, 잘못된 키는 교체 전 거부·옛 파일 그대로, CA 남은 기간 300일 미만이면 거부 |
| T-12 | W2 | CA 교체(`replace-ca`) | 임시 CA 둘로 옛→새 교체, 일부러 실패 주입 | 새 CA leaf만 통과·옛 CA leaf 거부, `share/ca.crt`·Runner CA 함께 바뀜, 실패 때 보관본으로 되돌아가 옛 CA로 접속됨 |
| T-13 | W3 | 옛 Runner 복구본과 `legacy-rollback` | 임시 저장소를 옛 커밋으로 두고 복구본 생성 → 저장소를 새 커밋으로 바꿈 → 전용 http 옛 스택에 대해 `legacy-rollback` | 옛 코드로 heartbeat 성공, 새 토큰 먼저·옛 토큰 나중, 두 Runner 동시 실행 0회, 6.1의 완료 조건 전부 |
| T-14 | W5 | 시스템 SSH push가 서버 키 확인을 유지한다(O-10) | `systemSshCommand` 단위 시험 | `StrictHostKeyChecking=yes`, `UserKnownHostsFile=<파일>`, `GlobalKnownHostsFile=/dev/null` 유지. 끄는 옵션 0개 |
| T-15 | W5 | SMTP·Telegram TLS | 설정 저장·연결 확인·발송 경로 | `없음` 거부, `STARTTLS`는 `requireTLS` 유지(O-10 결과에 따라 거부 가능), 인증서 검증 끄기 0개, Telegram은 `https://api.telegram.org`만(fake http는 시험 설정만) |
| T-16 | W2 | 설치기 안전장치 | 비밀 하나를 뺀 가져오기, `/mnt/c/…` prefix, 사람 계정으로 `curl --cacert share/ca.crt` | 가져오기 멈춤·새 비밀 생성 0개, DrvFS prefix 거부, 사람 계정 curl 성공 |
| T-17 | W2 | 설치·업그레이드·제거 | 임시 prefix로 설치 2회, 계약 지문이 다른 판으로 업그레이드, 제거 | 두 번째 설치 변경 0, 계약 변경 시 멈춤(`--contract-change-checked` 없이), 제거 뒤 `etc/`·`var/`·볼륨 남음 |
| T-18 | W2 | 복원 리허설 두 종류(2.6) | 현재 판 TLS 복원, 이행 전 HTTP 이미지 복원 | 둘 다 지문·API 대조 통과 |
| T-19 | W2 | 만료 경고 | certcheck에 leaf보다 CA가 먼저 끝나는 시험 CA | CA 만료일 기준으로 경고 |
| T-20 | owner | Windows 브라우저 | 3-2 등록 뒤 `https://127.0.0.1:8443` | 경고 없음. (참고 관찰: 이름 제약 위반 인증서를 브라우저가 거부하는지 — 보조 장치라 통과 조건 아님) |
| T-21 | W6 | 새 owner 명령서 | 모든 칸을 임시 prefix·HOME으로 글자 그대로 실행 | 칸마다 기대 출력과 같음, sudo 칸은 `norun` 표시와 이유 |

- 아직 시험하지 않은 것(정직하게): Windows에서 개인키가 든 파일(PFX)을 골랐을 때의 `HasPrivateKey` 분기는 실제 PFX로 시험하지 않았다(3-2 칸의 검사 문장만 있음). T-20과 함께 owner 명령서에서 「`.pfx`를 고르지 않는다」를 안내한다.

## 부록 A. 이 PC에서 한 검증(임시 폴더·전용 이름)

- 날짜 2026-11-28, OpenSSL 3.0.13, node v26.13.0, Docker Desktop 29.9.3 / compose 5.7.1, systemd 255
- 이름: 컨테이너 `awbs-tlsdesign-*`, 포트 `127.0.0.1:25491`·`25493`·`25494`. 끝난 뒤 `docker rm -f -v`로 지웠고 남은 컨테이너·볼륨 0개를 확인했다.
- 운영(`awbs-prod-*`)·`verum-*`·25432는 건드리지 않았다. sudo는 쓰지 않았다.

인증서 만들기(owner-cert.md의 명령 그대로, `OUT`만 임시 폴더)

```text
web.crt: OK
api.crt: OK
db.crt: OK
키 짝 일치: web
web: IP Address:127.0.0.1, DNS:localhost / 만료 Dec 30 10:22:04 2027 GMT
키 짝 일치: api
api: DNS:api, IP Address:127.0.0.1 / 만료 Dec 30 10:22:04 2027 GMT
키 짝 일치: db
db: DNS:postgres / 만료 Dec 30 10:22:04 2027 GMT
CA 만료: Nov 25 10:22:04 2036 GMT
--- 같은 폴더로 다시 실행 → FAIL 이미 있음(덮어쓰지 않음) exit=1
--- 이름 제약 음성 시험(example.com·8.8.8.8): error 47 at 0 depth lookup: permitted subtree violation, verify_exit=2
```

node·curl 신뢰

```text
fetch 127.0.0.1 (CA 미지정)            FAIL UNABLE_TO_VERIFY_LEAF_SIGNATURE
fetch 127.0.0.1 (NODE_EXTRA_CA_CERTS)  OK 200
fetch localhost (NODE_EXTRA_CA_CERTS)  OK 200
https.request({ ca }) — CA 고정         OK 200
curl --cacert ca.crt https://127.0.0.1 / https://localhost → ok / curl CA 미지정 → (60) unable to get local issuer certificate
```

컨테이너(키 `root:4242 0640`, 4242 = `awbs-secret` 역할의 시험 그룹)

```text
A. group_add 없이 nginx(uid 101) → cannot load certificate key … Permission denied
B. nginx groups=101(nginx),4242 / api(node) groups=1000(node),4242
   1차: proxy_ssl_name 127.0.0.1 → 502 "upstream SSL certificate does not match "127.0.0.1""  ← nginx는 IP로 검증 못 함
   2차(api 인증서에 DNS:api, proxy_ssl_name api):
   curl https://127.0.0.1 (CA 지정) → api ok /api/hello
   curl https://localhost (CA 지정) → api ok /api/hello
   nginx→api 이름 불일치(proxy_ssl_name localhost) → 502
   평문 http://127.0.0.1:25491 → 400
   openssl s_client: TLSv1.3, Verify return code: 0 (ok)
   api 직접(127.0.0.1:3100, NODE_EXTRA_CA_CERTS) → api ok /health
C. postgres(user 999:999 + group_add 4242), ssl=on, hostssl만
   node-postgres verify-full            OK {"ssl":true,"version":"TLSv1.3"}
   node-postgres 별명 db로 verify-full    FAIL ERR_TLS_CERT_ALTNAME_INVALID
   node-postgres sslmode=disable        FAIL 28000 pg_hba.conf rejects … no encryption
   psql verify-full → ssl=true TLSv1.3 / psql disable → rejects … no encryption
   docker exec 유닉스 소켓 → local ok
```

Windows(PowerShell 5.1, 읽기만 함. 신뢰 저장소에 넣지 않음)

```text
ca.cer Thumbprint(SHA-1) = 1157F9FCF9120C43922E505A84CC442437DC0E1F   ← WSL openssl SHA-1과 같음
web.crt: Build=True length=2 status=UntrustedRoot     ← 아직 등록 전이라 UntrustedRoot가 정상
evil.crt(example.com): Build=True length=2 status=UntrustedRoot  ← 이름 제약 위반을 따로 표시하지 않음(5.8 한계)
Import-Certificate cmdlet module: PKI
```

## 부록 A-2. 2판 추가 검증(리뷰 반영, 2026-11-28)

전체 로그: 작업 기록 폴더 `install-tls/verify-logs/fix1-*.log`. 이름 `awbs-fix1-*`(컨테이너·사용자 transient 유닛), 포트 127.0.0.1:25495. 끝난 뒤 컨테이너·볼륨·유닛 0개. sudo·실제 /opt·운영 자원 사용 없음.

```text
[Runner runtime, 서비스와 같은 PATH]  (fix1-runtime.log)
node=<runtime>/bin/node (v26.13.0)  npm=<runtime>/bin/npm (12.2.2)  npx=… (12.2.2)  pnpm=<runtime>/bin/pnpm (12.16.1)
node만 둔 PATH(리뷰 재현): npm=MISSING pnpm=MISSING
※ 시험은 nvm 폴더 복사로 했다. 그 폴더에 사람이 설치한 전역 codex가 들어 있어 설계는 공식 배포본으로 바꿨다(2.3)

[시작 래퍼, 사용자 transient 유닛 + 가짜 compose]  (fix1-start-wrapper.log)
raw(래퍼 없음): 상태=failed 자원표식=남음               ← 리뷰 재현
upfail: up_rc=1 → 상태=failed 종료코드=1 자원표식=없음   ← 래퍼가 down으로 정리, 원래 코드 유지
ok:     up_rc=0 → 상태=active
preflightfail: ExecStartPre 실패 → 상태=failed, up·down 둘 다 실행 안 됨

[nginx health 경로·api TLS 1.3·postgres 소켓 헬스체크]  (fix1-docker-fix.log)
/health → {"from":"api","path":"/health"}  /health/db → {"from":"api",…}  /api/x → {"from":"api",…}
web 컨테이너 헬스체크 curl --cacert … https://127.0.0.1:8443/health/db → api JSON
평문 http로 api 직접 → 000
api(minVersion TLSv1.3)에 TLS1.2 → 000(curl exit 35), TLS1.3 → 200
postgres(user 999, hostssl만) 소켓 pg_isready → healthy, 127.0.0.1 평문 TCP → pg_hba rejects … no encryption

[빌드 apt]  (fix1-docker-fix.log)
기반 이미지 apt 출처: http://deb.debian.org/debian, http://deb.debian.org/debian-security
https로만 바꿈 → Err … No system certificates available   ← slim 이미지에 CA 묶음 없음
nginx digest 이미지의 CA 묶음(142개, ca-certificates 20230311+deb12u1)을 넣고 https → apt-get update 성공, 평문 http 내려받기 0줄
※ 시험에서는 CA 묶음을 읽기 전용으로 붙여 이어지는 ca-certificates 설치의 정상 종료를 확인하지 못했다. Dockerfile의 COPY 방식(쓰기 가능)으로 W1이 확인한다

[PowerShell 지문 관문, Import-Certificate는 출력 함수로 바꿔 실제 등록 없음]  (fix1-ps-gate.log)
맞는 지문(그대로 / 소문자·콜론 섞음) → 「지문 일치 …」 + WOULD_IMPORT INTO Cert:\CurrentUser\Root
다른 지문 → 거부됨 → STOP: 지문이 다릅니다
자리표시 그대로 → 거부됨 → STOP: … 40자리를 넣으세요
web.crt를 고름(그 파일 지문을 넣어도) → 거부됨 → STOP: CA 인증서가 아닙니다

[owner-cert.md 2단계·6단계 칸 최종판, 글자 그대로]  (fix1-owner-block-run-final.log)
2단계 exit=0 → 즉시 다시 FAIL 이미 있음 exit=1, 기록 파일 2개 따로(첫 성공 기록 보존), PRIVATE KEY 0
6단계(갱신) exit=0 → 즉시 다시 FAIL 이미 있음, 갱신본 3장 원래 CA로 OK·일련번호 모두 다름
다른 CA 키 → FAIL CA 키와 CA 인증서가 짝이 아님 / 자리표시 경로 그대로 → FAIL CA 키 없음

[서비스 파일 2판]  (fix1-systemd-verify.log)
agent-wbs.service(ExecStart=agent-wbs start 등) exit=0 / agent-wbs-runner.service(runtime/current/bin, ExecStartPre) exit=0
```

## 부록 A-3. 3판 추가 검증(2차 리뷰 반영, 2026-11-28)

전체 로그: `install-tls/verify-logs/fix2-*.log`. 사용자 transient 유닛 `awbs-fix2-*`만 썼고 끝난 뒤 0개. sudo·실제 /opt·운영 자원·Windows 신뢰 저장소 변경 없음. 컨테이너는 만들지 않았다.

```text
[시작 래퍼 3판: 시도 표식 + ExecStopPost]  (fix2-start-wrapper.log, 시험 스크립트 fix2-agent-wbs-start.sh·fix2-agent-wbs-after-start.sh)
hang-timeout: up=hang timeout=3s → 상태=failed 결과=timeout 자원=없음   log: 시작 실패 정리: result=timeout code=killed status=TERM → down / 정리 완료
upfail:       up=fail          → 상태=failed 결과=exit-code 자원=없음
preflightfail:                 → 상태=failed 결과=exit-code 자원=없음(up 안 함)
ok-then-stop:                  → 상태=inactive 결과=success 자원=없음
2판 래퍼 + hang(리뷰2 재현)      → 상태=failed 결과=timeout 자원=남음
이미 떠 있던 스택 + preflight 실패 → 결과=exit-code 기존자원=그대로
시작 중 stop                    → 상태=failed 결과=signal 자원=없음   log: result=signal … → down / 정리 완료

[6단계 갱신 칸 3판: CA 남은 기간 검사]  (fix2-renew.log)
2단계(변경 없음) exit=0 / 6단계 정상(10년 CA) exit=0, 세 장 OK
만료 5일 남은 CA → FAIL CA가 397일 안에 만료됩니다(…). 갱신 대신 CA 교체 절차(설계 5.9)를 하세요. exit=1, 출력 폴더 만들지 않음
기록 파일 PRIVATE KEY 합계 0

[Windows CA 삭제 칸: 지문 하나만]  (fix2-ps-remove.log, Remove-Item을 출력 함수로 바꿈)
있는 지문(콜론·소문자 섞음) → 지울 인증서 1개 표시 → WOULD_REMOVE 1개: Cert:\CurrentUser\Root\<그 지문>
없는 지문 → STOP: 그 지문의 인증서가 현재 사용자 Root에 없습니다
자리표시 그대로 → STOP: … 40자리를 넣으세요
(양성 시험은 이 PC 현재 사용자 Root에 이미 있던 다른 루트 하나의 지문을 읽기만 해서 썼다)

[서비스 파일 3판]  (fix2-systemd-verify.log)
agent-wbs.service(ExecStopPost=agent-wbs after-start, RuntimeDirectory=agent-wbs) exit=0
agent-wbs-runner.service(UnsetEnvironment=NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED) exit=0
```

## 부록 B. systemd 서비스 파일 검증

임시 폴더에 서비스 파일 초안을 만들어 `systemd-analyze verify`만 했다(설치하지 않음).

```text
== verify agent-wbs.service (docker.service 의존판)
agent-wbs.service: Failed to create agent-wbs.service/start: Unit docker.service not found.
exit=1
== verify agent-wbs.service (Docker Desktop판)
exit=0
== verify agent-wbs-runner.service (시스템 서비스, User=keeproll, LoadCredential)
exit=0
== security 점수(참고)
→ Overall exposure level for agent-wbs-runner.service: 9.0 UNSAFE
```

## 부록 C. Codex 교차 리뷰(2026-11-28) 대응

| # | 리뷰 지적 | 반영한 곳 | 확인 |
| --- | --- | --- | --- |
| P1-1 | node만 복사하면 npm·pnpm 없음 | 2.3(공식 배포본+sha256, pnpm 12.16.1 고정, 같은 PATH 준비 점검), 4.1 PATH, W3 | 재현·해결 확인(A-2) |
| P1-2 | `up --wait` 실패 뒤 잔여 컨테이너, stop이 정리 못 함 | 3.2(`agent-wbs start` 래퍼, preflight 실패는 건드리지 않음, stop 실패 표시), 3.3, W2 | 사용자 transient 유닛으로 확인(A-2) |
| P1-3 | `/health`·`/health/db`·postgres 헬스체크가 TLS 밖 | 5.1 B·G·I·J, 5.2(`api-upstream.conf` include), 5.3(TLS 1.3), 5.4(소켓 헬스체크), W1 | docker 확인(A-2) |
| P1-4 | 복원 리허설이 http·CA 없음 | 2.6(리허설 TLS화, 두 종류 복원 시험, fake GitHub 시험 전용), 6.2, W2 | 설계(구현 W2) |
| P1-5 | 되돌리기가 옛 Runner·토큰을 못 살림 | 4.3(옛 유닛 보관, 동시 실행 거부), 4.5(새 토큰 먼저·옛 것 나중, 폐기 대상 하나로), 6.1(준비/전환/되돌리기·완료 조건), O-12, W3 `legacy-rollback` | 설계(구현 W3) |
| P1-6 | 빌드 apt가 http | 2.5(CA 묶음 먼저 → https), 5.1 E4, W1 인수 조건 | slim 이미지 CA 없음 함정까지 확인(A-2) |
| P2-7 | PowerShell 지문 확인 전에 import | owner-cert.md 3-2(지문 넣고, 불일치·CA 아님·개인키 포함이면 throw) | 모의 import로 5가지 확인(A-2) |
| P2-8 | USB(DrvFS) 0600 보장 안 됨 | owner-cert.md 5단계(암호 관리자·암호화 장치 권장, 보호 확인 뒤에만 원본 삭제, 「내용 같음」≠「안전」), O-9 보충 | 리뷰의 DrvFS 0777 확인 인용 |
| P2-9 | 갱신 절차·경고 없음, bind mount 옛 inode | 5.9(갱신 칸, 전체 restart, 실제 일련번호 확인, 되돌리기, 매일 timer, CA 교체 별도), owner-cert.md 6단계, O-11, W2 | 갱신 칸 실행 확인(A-2) |
| P2-10 | `etc/tls/ca.crt`를 owner가 못 읽음 | 2.2(`share/ca.crt`), 5.8 WSL 신뢰, owner-cert.md 4단계(node 예제 삭제) | 권한 대조 |
| P2-11 | GitHub API http 허용, 시스템 push는 SSH | 5.1 E2·E3, O-10, W4·W5 | 코드 대조 |
| 추가 | 비밀 가져오기 실패 시 새로 만들지 않기, 중단 전 준비, 백업 시점, 두 Runner 동시 실행, native fetch `{ca}` 무효, Docker Desktop 늦은 기동, oneshot active의 뜻 | 2.6, 6.1, 4.3, 5.5, 3.3 「알아 둘 한계」, O-13 | — |

### 2차 리뷰(2026-11-28) 대응

| # | 리뷰2 지적 | 반영한 곳 | 확인 |
| --- | --- | --- | --- |
| P1-1 | 시작 시간 초과·중단 때 래퍼가 정리 못 함 | 3.2(시도 표식 `RuntimeDirectory` + `ExecStopPost=after-start`, `$SERVICE_RESULT`로 판정), 2.4·3.3, T-2 | 사용자 transient 유닛 7가지(A-3). 실제 compose는 T-2 |
| P1-2 | node 안에서 `NODE_EXTRA_CA_CERTS`를 지워도 신뢰 유지 | 5.5(production 시작 거부, 서비스 `UnsetEnvironment`, preflight), 4.1, W4, T-9 | 리뷰2 실측 인용, 서비스 파일 verify |
| P1-3 | CA 교체가 새 인증서 거부·Windows 새 CA까지 삭제 | 5.9(`replace-ca` 분리, 두 CA를 잠깐 함께 신뢰, 실제 접속 확인 뒤 옛 CA를 **지문 하나로** 삭제, 사고 때 순서), owner-cert.md 3-3·7, T-12 | 지문 삭제 칸 모의 시험 3가지(A-3) |
| P1-4 | 서비스 파일만으론 옛 Runner 코드 복구 불가 | 6.1 3-1(옛 커밋 소스·운영 의존성·옛 node·고친 서비스 파일·MANIFEST 복구본, 새 판은 별도 worktree에서 실행, 복구본 점검 실패 시 `--activate` 거부), 되돌리기 3·4, O-12 조건, T-13 | 설계(구현 W3) |
| P2-5 | 오프라인 복사 목록에 `bin/npm`·`npx` 없음 | 2.3(부분 복사 방식 삭제, 같은 공식 tarball 파일로만), T-10 | 설계 |
| P2-6 | 갱신 때 CA 남은 기간 미확인 | owner-cert.md 6단계(`-checkend 34300800`, 폴더 만들기 전 거부), 5.9 `renew-cert`(CA 300일)·certcheck(먼저 끝나는 날), T-11·T-19 | 만료 5일 CA로 거부 확인(A-3) |
| 결정 조건 | O-10~O-13에 승인·보관 조건 | 7장 「O-10~O-13은 추천을 고르는 것만으로 승인되지 않는다」 | — |


## 용어

- **CA(인증 기관)** — 서버 인증서에 서명해 「이 서버가 맞다」를 보증하는 쪽. 사설 CA는 우리가 직접 만든 CA라 우리가 등록한 곳에서만 믿는다.
- **CA 고정** — 특정 연결에서 시스템의 공인 CA를 쓰지 않고 지정한 CA 하나만 믿는 것.
- **cgroup / scope** — 프로세스 묶음. scope는 systemd가 그 묶음에 붙인 이름표다(isolation 문서).
- **compose secrets** — compose가 호스트 파일을 컨테이너 안 `/run/secrets/<이름>`에 붙여 주는 기능.
- **CSP(Content-Security-Policy)** — 화면이 어디서 스크립트·이미지 등을 불러올 수 있는지 브라우저에 알려 주는 헤더.
- **Docker Desktop** — Windows에서 docker를 돌리는 프로그램. WSL 안에는 docker 명령만 연결되고 엔진은 Windows 쪽 가상 머신에서 돈다.
- **ECDSA P-256** — 인증서 키 종류의 하나. 짧고 빠르며 널리 지원된다.
- **group_add** — 컨테이너 안 프로세스에 추가 그룹 번호를 붙이는 compose 설정.
- **HSTS** — 「이 주소는 앞으로 https로만 접속하라」고 브라우저에 기억시키는 응답 헤더.
- **LoadCredential** — systemd가 서비스 시작 때 비밀 파일을 그 서비스만 읽는 폴더에 넣어 주는 기능.
- **nameConstraints(이름 제약)** — CA 인증서에 「이 이름들에만 서명할 수 있다」를 적는 확장.
- **oneshot 서비스** — 명령 하나를 실행하고 끝나는 systemd 서비스 형식. `RemainAfterExit=yes`면 끝난 뒤에도 「켜짐」으로 본다.
- **pg_hba.conf** — postgres가 누가 어떤 방식(TLS 여부·비밀번호 방식)으로 접속할 수 있는지 정하는 파일.
- **prefix** — 설치 위치의 맨 위 폴더(예: `/opt`).
- **SAN(subjectAltName)** — 인증서에 적는 「이 인증서가 쓰일 이름·IP 목록」. 브라우저·node·postgres는 이 목록으로 주소를 검증한다.
- **sslmode=verify-full** — postgres 접속 때 TLS를 쓰고, CA 서명과 서버 이름까지 모두 확인하는 방식.
- **시스템 서비스 / 사용자 서비스** — 시스템 서비스는 PC 전체의 systemd(PID 1)가, 사용자 서비스는 그 사용자 몫의 systemd가 관리한다. 시스템 서비스도 `User=`로 실행 계정을 정할 수 있다.
- **TLS** — 통신을 암호화하고 상대 서버가 맞는지 인증서로 확인하는 방식. https는 TLS 위의 http다.
- **upstream** — nginx가 요청을 넘기는 뒤쪽 서버(여기서는 api).
