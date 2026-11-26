# Agent 실행 격리 — 전용 OS 계정 (Q-08)

이 문서는 Agent(Claude·Codex)가 실행하는 명령이 이 PC의 다른 파일이나 비밀값을 건드리지 못하게 막는 방법을 설명한다.
owner가 2026-11-27(아이템 15)에 Q-08을 **(B) 전용 OS 사용자**로 정했다.
처음 보는 말은 맨 아래 [용어집](#용어집)에 모아 두었다.

## 1. 한눈에 보기

- Agent는 사람용 계정(keeproll)이 아니라 **Agent 전용 계정 `awbs-agent`**로 돈다.
- 이 계정은 로그인 셸(사람이 들어와 명령을 치는 프로그램)이 없고, sudo(관리자 권한 실행) 권한도 없다.
- Runner(keeproll로 도는 프로그램)는 **실행 래퍼(wrapper) 하나**만 이 계정으로 실행할 수 있다.
  - 이 허락은 sudoers(누가 어떤 명령을 다른 계정으로 실행해도 되는지 적은 설정 파일)에 한 줄로 적는다.
  - 래퍼 = 진짜 프로그램을 감싸서, 실행 전에 검사를 하고 나서 진짜 프로그램을 띄우는 작은 스크립트.
- Agent가 쓰는 폴더는 Runner 홈 밖의 **Agent 작업 영역 `/srv/agentwbs`**에 둔다.
- Agent는 Runner 홈(`/home/keeproll`) 안의 어떤 것도 읽지 못한다.
  - 예: `~/.agentwbs`(Runner 상태·bare 저장소), `~/.config/gh`(GitHub 로그인), `~/projects/verum-*`(다른 프로젝트), `~/.ssh`.
- WSL에서는 Windows 드라이브(`/mnt`)와 Windows 프로그램 실행 통로(`/run/WSL`)도 Agent 계정만 막는다.
- 설치는 owner가 스크립트 하나로 한다. 무엇을 할지 먼저 `--dry-run`으로 볼 수 있다.

## 2. 왜 전용 계정인가

- 같은 계정으로 돌리면, CLI sandbox(프로그램이 건드릴 수 있는 범위를 막아 둔 실행 환경)가 하나라도 뚫리는 순간 Runner의 모든 파일을 읽고 쓸 수 있다.
  - 왜 위험한가: `~/.agentwbs`에는 Runner 상태와 bare 저장소가, `~/.config/gh`에는 GitHub 로그인이 있다. M4-03 안내(`src/git/README.md`)도 이 점을 미결로 남겼다.
- 계정을 나누면 리눅스 커널의 파일 권한이 경계가 된다. CLI가 어떻게 동작하든 커널이 막는다.
- 세션별 컨테이너(C)보다 설치가 가볍고, WSL에서도 바로 쓸 수 있다.
- 대가: 계정 생성에 sudo가 한 번 필요하다. 그래서 설치 스크립트를 owner가 직접 실행한다.

## 3. 전체 구성

```text
keeproll (Runner)                      awbs-agent (Agent 전용 계정)
─────────────────                      ─────────────────────────────
~/.agentwbs/  (0700, Agent 못 읽음)      /home/awbs-agent/ (0700)
  repos/ state/ 비밀값                     .claude/ .codex/  ← Agent 계정의 로그인 정보
                                         tmp/              ← Agent 전용 임시 폴더
        │  sudo -n -u awbs-agent -- /usr/local/libexec/awbs-agent-exec run ...
        └──────────────────────────────▶ 래퍼가 검사 → 환경을 새로 만들고 → CLI 실행

/srv/agentwbs/ (소유 keeproll, 그룹 awbs-agent)
  cli/        Runner가 설치한 CLI. Agent는 읽기·실행만
  inputs/     입력 자료 사본. Agent는 읽기만
  worktrees/  세션 작업 폴더. Agent가 쓰는 곳은 여기뿐
  runtime/    Agent용 node(root 소유)
```

## 4. Agent 계정 규칙

- 이름은 `awbs-agent`(바꾸려면 설치 스크립트의 `--agent-user`).
- 시스템 계정(사람용이 아닌 계정)으로 만든다.
- 로그인 셸은 `/usr/sbin/nologin`이다.
  - 왜: 누구도 이 계정으로 로그인해 셸을 열 수 없게 한다. owner의 1회 로그인 작업은 owner의 sudo로 명령을 직접 지정해서 한다(§10).
- 비밀번호는 잠근다(`passwd --lock`).
- sudo·adm·docker 그룹에 넣지 않는다. Runner 그룹(keeproll)에도 넣지 않는다.
  - 왜 docker도 빼나: docker 그룹은 사실상 root와 같다. 컨테이너로 PC 전체를 열 수 있다.
  - 왜 Runner 그룹도 빼나: Runner 홈은 `0750`(그룹은 읽기 가능)이다. 그룹에 들면 Runner 홈에 들어간다.
- 홈 폴더 `/home/awbs-agent`는 `0700`이다. Claude·Codex 로그인 정보는 이 계정만 읽는다.

## 5. Runner가 Agent 계정으로 실행하는 방법

### 5.1 추천: sudoers NOPASSWD + root 소유 실행 래퍼

sudoers에 아래 한 줄만 넣는다(설치 스크립트가 만든다).

```text
Cmnd_Alias AWBS_AGENT_EXEC = /usr/local/libexec/awbs-agent-exec
Defaults!AWBS_AGENT_EXEC env_reset, !setenv
keeproll ALL=(awbs-agent) NOPASSWD: AWBS_AGENT_EXEC
```

- `(awbs-agent)`: Agent 계정으로만 실행한다. root로 실행하는 권한은 주지 않는다.
- `NOPASSWD`: 비밀번호 없이. Runner는 사람이 없을 때도 돌아야 하기 때문이다.
- `env_reset, !setenv`: Runner의 환경 변수를 넘기지 못하게 한다. 토큰이 실수로 섞여도 sudo에서 한 번 지워진다.
- 명령은 래퍼 하나뿐이다. 인자는 래퍼가 검사한다.
  - 왜 인자를 sudoers에 적지 않나: 모델 ID·세션 ID가 매번 달라 다 적을 수 없다. `*` 같은 와일드카드는 sudoers에서 예상보다 넓게 맞아 위험하다.

래퍼(`scripts/isolation/awbs-agent-exec.sh`, 설치 위치 `/usr/local/libexec/awbs-agent-exec`)가 하는 검사:

- 자기가 Agent 계정으로 돌고 있는지 본다. 아니면 거부한다(종료 코드 3).
  - 왜: Runner가 실수로 래퍼를 직접 부르면 격리된 것처럼 보이기만 한다.
- 작업 폴더의 실제 경로(링크를 모두 따라간 경로)가 `/srv/agentwbs/worktrees/` **안**인지 본다.
  - 예: 작업 폴더 안의 링크가 `/home/keeproll`을 가리키면 거부한다.
- CLI 실행 파일의 실제 경로가 `/srv/agentwbs/cli/<claude|codex>/` 안인지 본다. 다른 Agent의 CLI도 거부한다.
- 넘겨받는 환경 변수는 `LANG`·`LC_ALL`뿐이다. 다른 이름(예: `GH_TOKEN`)은 거부한다.
- 설정 파일(`/etc/agentwbs/agent-exec.conf`)은 실행하지 않고, 정해진 이름만 한 줄씩 읽는다.
  - 왜: 설정 파일에 명령을 숨겨 두어도 실행되지 않게 한다.
- 래퍼와 설정 파일은 root 소유다. Runner도 Agent도 고칠 수 없다.

Runner 쪽 코드(`src/cli/dedicated-user.ts`)가 만드는 실행 계획:

```text
/usr/bin/sudo -n -u awbs-agent -- /usr/local/libexec/awbs-agent-exec run \
  --agent codex --cwd /srv/agentwbs/worktrees/<프로젝트>/<시도> --env LANG=ko_KR.UTF-8 -- \
  /srv/agentwbs/cli/codex/<버전>/bin/codex -c check_for_update_on_startup=false exec --json ...
```

- `-n`: 비밀번호를 묻지 않는다. 규칙이 없으면 바로 실패한다. 멈춘 채 기다리지 않는다.
- `current` 링크는 이 시점의 버전 폴더로 바꿔 넘긴다.
  - 왜: 실행 중 CLI 업데이트가 링크를 바꿔도 이 세션은 같은 버전으로 끝까지 간다(architecture §5.1).
- 지시문은 지금처럼 표준 입력(stdin)으로 간다. 프로세스 목록(`ps`)에 보이지 않는다.

### 5.2 다른 방법과 비교

- **sudoers에 명령·인자를 그대로 적기**
  - 인자가 매번 달라 적을 수 없다. 와일드카드는 위험하다. → 쓰지 않는다.
- **setuid 도우미 프로그램 직접 만들기**(실행하면 다른 계정 권한을 얻는 프로그램)
  - 작은 실수 하나가 root 권한 탈출이 된다. 검증된 sudo보다 위험하다. → 쓰지 않는다.
- **`systemd-run --uid=awbs-agent` + polkit 규칙**(polkit = 일반 사용자에게 관리 작업 일부를 허락하는 장치)
  - 장점: 세션마다 cgroup이 자동으로 생긴다.
  - 단점: polkit 규칙으로 「awbs-agent로만」을 좁게 거는 방법이 마땅치 않다. 잘못 걸면 아무 계정으로나 서비스를 띄울 수 있다. → 지금은 쓰지 않는다. cgroup은 §8처럼 따로 얻는다.
- **SSH로 같은 PC의 Agent 계정에 접속**(강제 명령 키)
  - sshd를 켜고 키를 관리해야 한다. 접속 비용이 들고 설정할 곳이 늘어난다. → 쓰지 않는다.
- **`su`·`runuser`**
  - `su`는 Agent 계정 비밀번호가 필요하다. `runuser`는 root만 쓸 수 있다. → 쓸 수 없다.

## 6. 폴더와 권한

권한 숫자는 「소유자·그룹·나머지」 순서다. 예: `0750` = 소유자 읽기·쓰기·들어가기, 그룹 읽기·들어가기, 나머지 없음.

- `/srv/agentwbs` — 소유 keeproll, 그룹 awbs-agent, `0750`.
  - Agent는 들어가기만 한다. 맨 위에 새 폴더를 만들 수 없다.
- `/srv/agentwbs/cli` — `2750`. Runner가 CLI를 설치한다. Agent는 읽기·실행만 한다.
  - 앞자리 `2`(setgid): 안에 새로 만드는 파일·폴더의 그룹이 자동으로 awbs-agent가 된다. 그래야 Agent가 읽을 수 있다.
  - 왜 Agent가 못 고치게 하나: Agent가 CLI를 바꿔치기하면 다음 세션이 그 프로그램을 쓴다.
- `/srv/agentwbs/inputs` — `2750`. 입력 사본 파일은 git 계층이 `0444`, 폴더는 `0555`로 만든다.
  - Agent는 소유자가 아니라서 권한을 되돌릴 수 없다.
  - 왜 중요한가: M4-03 안내는 「같은 사용자면 읽기 전용 입력 사본의 권한도 다시 바꿀 수 있다」를 미결로 두었다. 계정을 나누면 이 문제가 닫힌다.
- `/srv/agentwbs/worktrees` — `2750` + **기본 ACL**.
  - ACL(권한 목록) = 소유자·그룹 말고도 「이 계정에는 이 권한」을 따로 적는 기능.
  - 기본 ACL = 새로 만드는 파일·폴더에 자동으로 붙는 ACL.
  - 기본 ACL 값: `d:u:keeproll:rwx, d:u:awbs-agent:rwx, d:g::r-x, d:m::rwx, d:o::---`.
  - 그래서 Runner가 만든 작업 폴더 안에 Agent가 쓸 수 있고, Agent가 만든 파일을 Runner가 읽고 지울 수 있다.
  - 맨 위(`worktrees` 자체)는 Agent가 바꾸지 못한다.
- `/srv/agentwbs/runtime/node/bin/node` — root 소유 `0755`. Agent용 node다.
  - 왜 복사하나: Runner의 node는 `~/.nvm`(Runner 홈 안)이라 Agent가 실행할 수 없다. Claude·Codex CLI는 node로 돈다.
  - node를 올리면 설치 스크립트를 다시 실행한다(같은 단계가 새 파일로 덮어쓴다).
- `/home/awbs-agent` — `0700`. Agent 로그인 정보와 `tmp/`(Agent의 `TMPDIR`)가 있다.

Agent 계정이 못 읽는 곳(확인 스크립트가 하나씩 시험한다):

- `/home/keeproll` 전체. 홈이 `0750`이고 Agent는 keeproll 그룹이 아니기 때문이다.
  - 그 안의 `~/.agentwbs`(`0700`), `~/.config/gh`, `~/.ssh`, `~/.orca`, `~/.claude`, `~/.codex`, `~/projects/verum-*`, `~/.config/verum-*`.
- `/mnt`(Windows 드라이브), `/run/WSL`(Windows 실행 통로), `/Docker`, `/var/run/docker.sock`.

## 7. 환경 변수(env allowlist와 결합)

환경 변수는 두 번 거른다.

1. Runner가 거른다(M5-01 `sessionEnv`, 기존 allowlist).
   - 허용 목록(allowlist)에 있는 이름만 남긴다. 토큰·SSH agent·`AWBS_*`·API 키는 여기서 빠진다.
2. 전용 계정 계층이 한 번 더 줄인다.
   - sudo 자신에게는 `PATH=/usr/bin:/bin`만 준다.
   - 래퍼에는 `LANG`·`LC_ALL`만 인자로 넘긴다.
   - 래퍼가 `env -i`(환경을 모두 비우기)로 시작해 아래 값만 새로 만든다.
     - `HOME=/home/awbs-agent`, `USER`·`LOGNAME=awbs-agent`
     - `PATH=/srv/agentwbs/runtime/node/bin:/usr/local/bin:/usr/bin:/bin`
     - `TMPDIR=/home/awbs-agent/tmp`
     - `DISABLE_AUTOUPDATER=1`, `DISABLE_UPDATES=1`(CLI 버전은 Runner만 바꾼다, architecture §5.1)
- 왜 Runner의 `HOME`·`CODEX_HOME`·`CLAUDE_CONFIG_DIR`·`XDG_CONFIG_HOME`를 넘기지 않나: 모두 Runner 계정 폴더다. Agent는 자기 홈의 로그인 정보를 써야 한다.

## 8. CLI 권한 모드

전용 계정 계층은 CLI 옵션도 정한다(`DEDICATED_FLAGS`). 이 옵션은 관측 등급 조합의 「옵션」에 들어간다(`sessionOptions`). 그래서 옵션을 바꾸면 조합이 「미검증」으로 돌아간다(G §6.7).

- Claude: `--permission-mode bypassPermissions`
  - 왜: `-p` 실행은 사람이 없어 승인 질문에 답할 수 없다. 승인 없이는 시험·빌드 명령을 못 돌린다.
  - 대신 OS 계정이 실제 경계다.
- Codex: `-c approval_policy="never" -c sandbox_mode="workspace-write"`
  - 승인은 묻지 않는다. CLI sandbox는 켜 둔다(두 번째 울타리).
  - 주의: `workspace-write`는 기본으로 네트워크를 막는다. 패키지 설치가 필요한 Task가 막힐 수 있다. M8 실검증에서 확인한다.
- 이 값은 owner·조정자가 바꿀 수 있는 정책이다. 결정이 바뀌면 `DEDICATED_FLAGS`만 고친다.

## 9. 프로세스 정리(프로세스 그룹·cgroup)

리눅스에서는 다른 계정의 프로세스에 신호(종료 요청)를 보낼 수 없다. 그래서 Runner(keeproll)는 Agent 프로세스를 직접 죽이지 못한다(`EPERM`, 권한 없음 오류).

- 살아 있는지 확인(`kill -0`)은 지금처럼 된다. `EPERM`은 「살아 있음」으로 본다(`processGroupEmpty`가 이미 그렇게 한다).
- 정리 순서(exec 계층 M5-02·M5-03에서 연결):
  1. **cgroup을 쓸 수 있으면** 세션 cgroup의 `cgroup.kill`에 1을 쓴다.
     - cgroup(control group) = 프로세스 묶음별로 CPU·메모리를 재고 제한하는 리눅스 기능.
     - Runner가 만든 cgroup 안의 프로세스는 계정과 상관없이 커널이 한 번에 끝낸다. Agent는 다른 계정의 cgroup 파일을 쓸 수 없어 빠져나가지 못한다.
     - sudo는 Ubuntu에서 새 로그인 세션(pam_systemd)을 만들지 않으므로 Agent 프로세스는 Runner의 세션 cgroup에 그대로 남는다. 이 PC에서 쓸 수 있는지는 M5-03에서 확인한다.
  2. **안 되면** 래퍼 `kill-group <pgid>`를 Agent 계정으로 실행한다(`agentControl`).
     - Agent 계정으로 보내므로 그 그룹의 Agent 프로세스만 끝난다. Runner·root 프로세스에는 닿지 않는다.
  3. **세션이 0이 되면** 래퍼 `kill-all`로 Agent 계정에 남은 프로세스를 청소한다.
     - 전용 계정이라 「이 계정의 프로세스 = Agent 실행」이다. 그룹을 빠져나간(`setsid`) 자손도 여기서 잡힌다.
     - 그래도 남으면 「정리 안 된 실행」 알림을 올린다(G §6.7 규칙 4).
- 작업 폴더를 지우기 전에 래퍼 `fix-perms <경로>`로 Agent 파일에 Runner 권한을 되돌린다.
  - 왜: Agent가 자기 파일의 권한을 지우면(예: `chmod 000`) Runner가 지울 수 없다.

## 10. owner가 실행할 절차

모든 명령은 Runner 계정(keeproll)으로, 저장소 맨 위 폴더에서 실행한다. `sudo bash ...`로 부르지 않는다. 스크립트가 필요한 줄만 sudo로 실행한다.

### 10.1 미리 보기(아무것도 바꾸지 않음)

```bash
bash agent-runner/scripts/isolation/setup-agent-user.sh --dry-run
```

### 10.2 설치

```bash
bash agent-runner/scripts/isolation/setup-agent-user.sh
```

- 중간에 sudo 비밀번호를 묻는다.
- 다시 실행해도 된다. 이미 있는 계정·폴더는 두고 권한·파일만 다시 맞춘다.
- 하는 일(스크립트 안에 한 줄씩 한글 주석):
  1. `acl` 패키지 설치(없을 때만).
  2. `awbs-agent` 계정 만들기, 비밀번호 잠금, 홈 `0700`, Agent의 git 설정(`safe.directory`).
  3. `/srv/agentwbs` 폴더와 권한, Agent용 node 복사.
  4. 래퍼·설정 파일 설치(root 소유).
  5. sudoers 규칙 설치(먼저 `visudo -c`로 문법 검사).
  6. WSL이면 `/mnt`·`/Docker`·`/run/WSL`에 Agent 차단 ACL, 부팅 때 `/run/WSL`을 다시 막는 서비스 등록.

### 10.3 Runner 설정

`agent-runner/.env`에 아래 세 줄을 넣는다.

```bash
AWBS_AGENT_USER=awbs-agent
AWBS_AGENT_ROOT=/srv/agentwbs
AWBS_AGENT_EXEC=/usr/local/libexec/awbs-agent-exec
```

- `AWBS_AGENT_USER`가 비어 있으면 Runner는 지금처럼 실제 실행 계획을 만들지 않는다(`isolation_undecided`).
- 넣어도 래퍼 `check`가 `ok`를 내야만 전용 계정을 쓴다(`selectIsolation`).
  - 왜: 설정만 믿으면 sudoers·래퍼·WSL 보호가 빠진 PC에서 격리된 줄 알고 실행하게 된다.

### 10.4 Agent 계정 로그인(한 번)

Runner가 `/srv/agentwbs/cli`에 CLI를 설치한 뒤에 한다(§12의 후속 연결이 끝나야 그 위치에 설치된다).

```bash
# Claude: 화면에 나오는 주소를 Windows 브라우저에 붙여 넣고, 받은 코드를 다시 붙여 넣는다.
sudo -u awbs-agent -H -- env -C /home/awbs-agent PATH=/srv/agentwbs/runtime/node/bin:/usr/bin:/bin \
  /srv/agentwbs/cli/claude/current/bin/claude auth login

# Codex: 기기 코드 방식. 화면의 주소와 코드를 Windows 브라우저에서 입력한다.
sudo -u awbs-agent -H -- env -C /home/awbs-agent PATH=/srv/agentwbs/runtime/node/bin:/usr/bin:/bin \
  /srv/agentwbs/cli/codex/current/bin/codex login --device-auth
```

- 브라우저가 자동으로 열리지 않는다. Agent 계정은 Windows 프로그램을 실행할 수 없기 때문이다(§6). 주소를 직접 복사한다.
- 로그인 정보는 `/home/awbs-agent/.claude`·`.codex`에 저장된다. Runner 계정의 로그인과 따로다.
- 두 명령 이름은 이 PC의 설치본(Claude 2.1.332 `claude auth --help`, Codex 0.172.0 `codex login --help`)에서 확인했다. 버전이 바뀌어 없으면 `--help`로 다시 본다.
- 로그인은 돈이 들지 않는다. 모델 호출은 하지 않는다.

### 10.5 설치 후 확인

```bash
bash agent-runner/scripts/isolation/check-agent-user.sh
# 다른 비밀 폴더도 시험하려면 --protect를 더한다.
bash agent-runner/scripts/isolation/check-agent-user.sh --protect /home/keeproll/projects/verum-sdn
```

- 줄마다 `PASS`·`FAIL`·`WARN`이 나온다. `FAIL`이 하나라도 있으면 종료 코드 1이다.
- 확인 항목:
  - 계정: 로그인 셸 없음, sudo·adm·docker·Runner 그룹에 없음.
  - 실행 권한: Runner가 비밀번호 없이 래퍼만 실행됨. 래퍼가 아닌 명령(`/bin/true`)과 root로는 안 됨.
  - 못 읽는 곳: Runner 홈, `~/.agentwbs`, `~/.config/gh`, `~/.ssh`, `~/.orca`, `~/.claude`, `~/.codex`, `~/projects/verum-*`, `~/.config/verum-*`, 그리고 `--protect` 경로.
  - WSL: `/mnt`·`/mnt/c`·`/run/WSL`·`/Docker/host`에 못 들어감. 진짜 Windows 프로그램(`whoami.exe` 복사본)을 Agent로 실행해 보고 막히는지 본다.
  - Docker 소켓을 못 씀.
  - 작업 영역: CLI는 읽기만, 입력 자료는 못 씀, 작업 폴더 안에 쓰고 Runner가 다시 지울 수 있음.
  - 로그인 상태(`auth status`·`login status`, 돈 안 듦).
  - 참고: `/tmp`에 Runner 계정의 공개 파일이 있으면 경고.
- 3단계부터 owner의 sudo 비밀번호를 물을 수 있다. 확인은 아무것도 고치지 않는다.
- 주의: owner 계정에 「모든 명령 비밀번호 없음」 규칙이 따로 있으면 2단계의 `/bin/true` 확인이 FAIL로 나온다. 그 규칙 때문이지 Agent 규칙 때문이 아니다.

### 10.6 되돌리기

```bash
bash agent-runner/scripts/isolation/remove-agent-user.sh --dry-run        # 보기만
bash agent-runner/scripts/isolation/remove-agent-user.sh                  # 계정·래퍼·규칙 제거(작업 영역은 남김)
bash agent-runner/scripts/isolation/remove-agent-user.sh --purge-work     # 작업 영역까지 삭제
```

- Runner를 먼저 멈춘다. 남은 Agent 프로세스는 스크립트가 강제로 끝낸다.
- sudoers 규칙을 가장 먼저 지운다. 정리하는 동안 새 세션이 뜨지 않게 하기 위해서다.
- 계정을 지우면 Agent 로그인 정보도 함께 지워진다.
- `.env`의 `AWBS_AGENT_*` 세 줄도 지운다. 그러면 Runner는 다시 실제 실행을 거부한다.

## 11. 남은 위험(이 방법이 막지 못하는 것)

- **세션끼리는 서로 막지 못한다.** 모든 세션이 같은 Agent 계정을 쓴다. 한 세션이 같은 프로젝트의 다른 작업 폴더를 읽고 쓸 수 있다.
  - 보조 수단: Codex `workspace-write` sandbox. 세션별 계정·컨테이너는 Q-08 범위 밖이다.
- **같은 PC의 네트워크 서비스에는 접속할 수 있다.** 예: Agent WBS 서버(`127.0.0.1:3100`), 개발 DB.
  - 서버 API는 Runner 토큰·팀장 로그인이 있어야 쓸 수 있다. DB는 비밀번호를 기본값으로 두지 않는다.
  - 더 막으려면 nftables(리눅스 방화벽)의 「계정별 규칙」으로 Agent 계정의 특정 포트 접속을 막을 수 있다. 이번 설치에는 넣지 않았다.
- **`/tmp`는 모든 계정이 같이 쓴다.** Runner·Orca가 `/tmp`에 누구나 읽을 수 있는 파일을 두면 Agent도 읽는다.
  - 이 PC에서도 `/tmp/awbs-m307-review-…` 같은 리뷰 사본이 `0755`로 있다(확인 스크립트가 경고로 센다).
  - 권장: Runner·리뷰 작업은 개인 임시 폴더(`TMPDIR`)를 쓴다.
- **추상 유닉스 소켓**(파일 없이 이름만 있는 프로세스 사이 통신 통로)은 계정 권한으로 막히지 않는다. 다른 프로그램이 이런 통로를 인증 없이 열어 두면 Agent도 닿는다.
- **WSL 보호는 부팅 순서에 기댄다.** `/run/WSL`은 부팅마다 새로 만들어진다. 보호 서비스가 돌기 전에는 열려 있다.
  - 그래서 Runner는 실행 전에 래퍼 `check`로 다시 확인한다. 열려 있으면 `fail wsl_interop_accessible`로 실행을 거부한다.
- **Agent가 작업 폴더의 git 설정을 바꿀 수 있다.** Runner가 그 폴더에서 git을 실행하면 바뀐 설정이 Runner 권한으로 돌 수 있다.
  - 지금 `importWorktree`는 bare 저장소에서 `fetch`만 하고 `--upload-pack`을 고정한다. 이 경로가 계정이 다른 폴더에서도 안전한지 M5-02 연결 때 다시 검토한다.

## 12. 후속 연결 작업(이번 변경에 없음)

이번 변경은 격리 계층·설치 스크립트·확인 스크립트까지다. 실제로 쓰려면 아래 연결이 더 필요하다.

1. **작업 폴더·입력 사본 위치**: git 계층(`GitRepository`)이 `worktrees/`·`inputs/`를 `AWBS_HOME`(`~/.agentwbs`) 대신 `AWBS_AGENT_ROOT` 아래에 만들게 한다.
   - 지금 위치는 Runner 홈 안이라 Agent가 들어갈 수 없다. 래퍼는 이 경우 `작업 폴더는 … 안이어야 합니다`로 거부한다.
2. **CLI 설치 위치**: CLI 업데이트(`cli-update`)가 `~/.agentwbs/cli` 대신 `AWBS_AGENT_ROOT/cli`에 설치하게 한다.
3. **준비 점검의 로그인 확인**: 지금은 Runner 계정으로 `auth status`를 본다. 전용 계정을 쓰면 Agent 계정으로 확인해야 한다.
4. **exec 계층(M5-02)**: 준비 점검에서 `selectIsolation`을 부르고, 정리에 `agentControl`(`kill-group`·`kill-all`·`fix-perms`)을 쓴다.
5. **CI·계약 추출·임시 SQL**도 같은 계정 경계에서 실행한다(architecture §4 「실행 격리」). 래퍼에 하위 명령을 더하거나 같은 방식의 실행 계획을 쓴다.

## 13. 시험

```sh
pnpm -C agent-runner test -- cli
```

- `test/cli/dedicated-user.test.ts`: 「계정이 있다고 가정한」 명령 구성. 실제 계정·sudo 없이 실행 계획 모양만 본다.
- `test/cli/agent-exec.test.ts`: 래퍼를 실제 bash로 돌린다.
  - 설정 파일 경로만 시험 폴더로 바꾼 사본을 쓰고, 「Agent 계정」은 시험을 돌리는 계정으로 둔다.
  - sudo 자리에는 fake sudo를 둔다. 인자 모양(`-n -u <계정> --`)을 확인하고 환경을 비운 뒤 실행한다.
- 스크립트 검사: `bash -n`(문법)과 shellcheck(셸 스크립트 검사 도구) 0.10.0.

## 용어집

- **ACL(권한 목록)**: 소유자·그룹 말고도 특정 계정에 권한을 따로 적는 기능. `setfacl`로 쓰고 `getfacl`로 본다.
- **기본 ACL**: 폴더에 걸어 두면, 그 안에 새로 만드는 파일·폴더에 자동으로 붙는 ACL.
- **allowlist(허용 목록)**: 목록에 있는 것만 통과시키는 방식. 반대는 「막을 것만 적는」 방식.
- **bare 저장소**: 작업 파일 없이 git 기록만 보관하는 저장소.
- **cgroup(control group)**: 프로세스 묶음별로 CPU·메모리를 재고 제한하고, 묶음째 끝낼 수 있는 리눅스 기능.
- **CLI sandbox**: CLI 프로그램이 스스로 건드릴 수 있는 파일·네트워크 범위를 막는 기능.
- **dry-run**: 실제로 바꾸지 않고 무엇을 할지 보여 주기만 하는 실행.
- **EPERM**: 「권한 없음」 오류. 다른 계정의 프로세스에 신호를 보내면 난다.
- **env(환경 변수)**: 프로그램에 넘기는 설정 값. 예: `HOME`, `PATH`.
- **interop(WSL)**: WSL 안에서 Windows 프로그램(.exe)을 실행하게 해 주는 기능. 실행된 프로그램은 Windows 사용자 권한으로 돈다.
- **nologin**: 로그인을 거부하는 셸. 계정은 있지만 사람이 들어와 명령을 칠 수 없다.
- **NOPASSWD**: sudoers에서 「비밀번호를 묻지 않는다」는 표시.
- **pgid(프로세스 그룹 번호)**: 함께 다루는 프로세스 묶음의 번호. 묶음 전체에 신호를 한 번에 보낼 수 있다.
- **polkit**: 일반 사용자에게 관리 작업 일부를 허락하는 장치.
- **setgid 폴더**: 안에 만드는 파일·폴더의 그룹을 폴더의 그룹으로 맞추는 폴더 설정. 권한 숫자 앞자리 `2`.
- **setuid 프로그램**: 실행하면 파일 소유자의 권한을 얻는 프로그램.
- **sudo**: 다른 계정(보통 관리자) 권한으로 명령을 실행하는 도구.
- **sudoers**: 누가 어떤 명령을 어느 계정으로 sudo 실행해도 되는지 적은 설정 파일. `/etc/sudoers.d/` 아래에 나눠 둔다.
- **visudo -c**: sudoers 파일 문법 검사. 틀린 파일을 넣으면 sudo 전체가 멈출 수 있어 먼저 검사한다.
- **래퍼(wrapper)**: 진짜 프로그램을 감싸서, 검사를 먼저 하고 진짜 프로그램을 띄우는 작은 스크립트.
- **실제 경로(realpath)**: 링크(지름길)를 모두 따라간 진짜 경로.
- **작업 영역**: 이 문서에서 `/srv/agentwbs`. Agent가 쓰는 폴더를 Runner 홈 밖에 모아 둔 곳.
