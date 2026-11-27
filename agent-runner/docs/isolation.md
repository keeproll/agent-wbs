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

- 이름은 `awbs-agent`로 **고정**이다. 설치·제거·확인 스크립트에도, Runner 설정에도 바꾸는 옵션이 없다.
  - 왜: 옵션 오입력 하나로 root나 다른 계정을 잠그거나 지우면 안 된다(Codex 리뷰 P2-2).
- 설치는 계정을 만드는 순서를 이렇게 한다(Codex 재리뷰 P2-B).
  1. 비어 있는 시스템 UID(999부터 아래로)를 고른다.
  2. **계정을 만들기 직전에** 진행 기록 `/etc/agentwbs/agent-user.pending`(root 소유)에 「이름 UID 생성표식」을 먼저 적는다.
  3. 그 UID로 계정을 만들고, 계정 설명 칸(GECOS)에 생성 표식 `Agent WBS agent awbs-agent-setup-<16자리 16진수>`를 넣는다.
  4. UID를 `/etc/agentwbs/agent-user.uid`에 기록하고, 진행 기록을 지운다.
  - 왜: 3과 4 사이에서 실패해도 정리 코드(trap)가 진행 기록으로 「이번 설치가 방금 만든 계정」만 되돌릴 수 있다. 이름·UID·생성 표식이 모두 기록과 같을 때만 지우고, 하나라도 다르면 기록을 남긴 채 손대지 않는다.
  - 강제 종료로 정리 코드조차 못 돌았으면, 다음 설치가 진행 기록을 보고 같은 방법으로 되돌린 뒤 새로 만든다.
  - 설명 칸은 root만 바꿀 수 있다. Agent 계정은 비밀번호가 잠겨 `chfn`(설명 바꾸기)을 못 한다.
- 같은 이름의 계정이 이미 있으면 아래가 모두 맞을 때만 「이 설치가 만든 계정」으로 본다. 하나라도 다르면 설치·제거 모두 손대지 않고 멈춘다.
  - 시스템 계정 번호(1~999), 기본 그룹 `awbs-agent`(같은 번호), 홈 `/home/awbs-agent`, 셸 `/usr/sbin/nologin`, 다른 그룹 소속 없음, 설명 칸이 생성 표식 모양.
  - 그리고 UID 기록과 같음. UID 기록이 없을 때는 진행 기록의 UID·표식과 같거나, 진행 기록도 없으면 생성 표식으로만 찾는다(제거 스크립트가 정리할 수 있게).
- 시스템 계정(사람용이 아닌 계정)으로 만든다.
- 로그인 셸은 `/usr/sbin/nologin`이다.
  - 왜: 누구도 이 계정으로 로그인해 셸을 열 수 없게 한다. owner의 1회 로그인 작업은 owner의 sudo로 명령을 직접 지정해서 한다(§10).
- 비밀번호는 잠근다(`passwd --lock`).
- sudo·adm·docker 그룹에 넣지 않는다. Runner 그룹(keeproll)에도 넣지 않는다.
  - 왜 docker도 빼나: docker 그룹은 사실상 root와 같다. 컨테이너로 PC 전체를 열 수 있다.
  - 왜 Runner 그룹도 빼나: Runner 홈은 `0750`(그룹은 읽기 가능)이다. 그룹에 들면 Runner 홈에 들어간다.
- 예약 실행(cron·at)을 쓰지 못하게 `/etc/cron.deny`·`/etc/at.deny`에 이름을 넣는다(리뷰4 P3-3).
  - 왜: cron은 로그인 셸(nologin)·비밀번호 잠금과 상관없이 작업을 돌린다. Agent가 세션 중에 작업을 심으면 세션·Runner가 끝난 뒤에도 계속 돈다.
  - `cron.allow`(또는 `at.allow`)가 있으면 deny 파일은 쓰이지 않는다. 이때는 allow 목록에 Agent가 없어야 하며, 있으면 설치가 멈춘다.
  - 제거할 때는 Agent의 crontab 파일과 at 작업을 계정 삭제 전에 지우고, 계정이 없어진 뒤 deny 파일에서 그 줄만 뺀다.
- 홈 폴더 `/home/awbs-agent`는 `0700`이다. Claude·Codex 로그인 정보는 이 계정만 읽는다.

## 5. Runner가 Agent 계정으로 실행하는 방법

### 5.1 추천: sudoers NOPASSWD + root 소유 실행 래퍼

sudoers에 아래 한 줄만 넣는다(설치 스크립트가 만든다).

```text
keeproll ALL=(awbs-agent) NOPASSWD: /usr/local/libexec/awbs-agent-exec
```

- 별칭(Cmnd_Alias)이나 추가 기본값(Defaults) 없이 이 한 줄만 둔다.
  - 왜: 확인 스크립트가 `sudo -l` 출력을 이 한 줄과 글자 그대로 맞춰 보기 위해서다(Codex 재리뷰 P2-A).

- `(awbs-agent)`: Agent 계정으로만 실행한다. root로 실행하는 권한은 주지 않는다.
- `NOPASSWD`: 비밀번호 없이. Runner는 사람이 없을 때도 돌아야 하기 때문이다.
- 환경 변수: sudo 기본값(`env_reset` 켜짐, `setenv` 꺼짐)대로 Runner의 환경 변수는 넘어가지 않는다. 토큰이 실수로 섞여도 sudo에서 한 번 지워진다. 기본값이 바뀌면 확인 스크립트가 FAIL을 낸다.
- 명령은 래퍼 하나뿐이다. 인자는 래퍼가 검사한다.
  - 왜 인자를 sudoers에 적지 않나: 모델 ID·세션 ID가 매번 달라 다 적을 수 없다. `*` 같은 와일드카드는 sudoers에서 예상보다 넓게 맞아 위험하다.

래퍼(`scripts/isolation/awbs-agent-exec.sh`, 설치 위치 `/usr/local/libexec/awbs-agent-exec`)가 하는 검사:

- 자기가 Agent 계정으로 돌고 있는지 본다. 아니면 거부한다(종료 코드 3).
  - 왜: Runner가 실수로 래퍼를 직접 부르면 격리된 것처럼 보이기만 한다.
- 작업 폴더의 실제 경로(링크를 모두 따라간 경로)가 `/srv/agentwbs/worktrees/` **안**인지 본다.
  - 예: 작업 폴더 안의 링크가 `/home/keeproll`을 가리키면 거부한다.
- CLI는 **진입점 하나만** 받는다: `/srv/agentwbs/cli/<claude|codex>/<버전>/bin/<claude|codex>`(조정자 결정 4, fix1).
  - `<버전>`은 숫자.숫자.숫자이고 링크가 아닌 실제 폴더여야 한다. `current` 링크는 Runner가 실행 시점의 버전으로 바꿔 넘긴다.
  - 진입점은 보통 패키지 안 파일을 가리키는 링크다. 링크를 따라간 실제 파일도 그 버전 폴더 안이어야 한다.
  - 왜: CLI 묶음 안에는 `rg`·`bwrap` 같은 다른 실행 파일도 있다. `bwrap`은 임의 명령을 띄울 수 있으므로 진입점만 받는다.
    - CLI가 세션 안에서 스스로 부르는 `rg` 등은 같은 계정·같은 scope의 자식이라 따로 허용할 필요가 없다.
  - 다른 Agent의 CLI도 거부한다.
- `git-inspect --cwd <작업 폴더>`·`git-bundle --cwd <작업 폴더> --branch <이름>`(fix2, 조정자 결정 6): Agent 작업 폴더의 git을 Agent 계정이 돌린다. 시스템·전역 설정 없음, `GIT_ALLOW_PROTOCOL=none`, `GIT_NO_LAZY_FETCH=1`, hook·fsmonitor 끔. Runner는 사용자 scope 안에서 부르고 끝나면 scope를 비운다.
  - fix3: 그 작업 폴더 하나만 `-c safe.directory=<폴더>`(명령줄 보호 설정)로 허용한다. 작업 폴더 소유자가 Runner 계정이라 git이 「dubious ownership」으로 거부하기 때문이다. `ci-run`도 같은 이유로 `GIT_CONFIG_*` 환경 변수로 그 사본 하나만 허용한다(실행마다 새 HOME이라 Agent 계정의 전역 설정이 없다). Claude·Codex 세션(`run`)은 Agent 계정 전역 설정(`safe.directory '*'`, 설치 스크립트가 넣음)을 그대로 쓴다.
- `cli-version --tool claude|codex|pnpm -- <진입점>`(fix2, 조정자 결정 8): 새로 설치한 CLI의 `--version`을 Agent 계정으로 실행한다(`install-agent-cli.sh`가 쓴다).
- `agent-file read|write|remove --cwd <작업 폴더> --path <.claude|.codex>/agents/<이름>`(fix2 추가): 하위 Agent 정의 파일을 Agent 계정이 다룬다. 경로는 정해진 모양만(`.awbs-installed.json` 또는 `<키>.md|toml`), 1 MiB까지, 없는 파일 읽기는 종료 코드 3.
- `ci-run`(①·CI 검사 명령, 조정자 결정 1, fix1): Agent 코드의 시험·빌드를 Agent 계정으로 실행한다.
  - `--home <작업 폴더>/.awbs-home`이 필수다(fix2, 조정자 결정 8). 실행마다 새 HOME·TMPDIR(pnpm 저장소 포함)라 다른 Task와 공유하지 않는다.
  - 작업 폴더는 `run`과 같은 규칙(worktrees 안)이다.
  - 명령은 이름(예: `pnpm`)이면 고정 PATH(`<Agent node>:/srv/agentwbs/cli/pnpm/current/bin:/usr/local/bin:/usr/bin:/bin`)에서 찾고, 경로면 작업 폴더 안의 실행 파일만 받는다.
  - 환경 변수는 `LANG`·`LC_ALL`·`TZ`·`CI`·`NODE_ENV`·`FORCE_COLOR`·`NO_COLOR`·`AWBS_REPORT`·`AWBS_REPORT_NONCE`·`AWBS_EVIDENCE_DIR`만, 값은 경로·짧은 낱말 모양만 받는다.
  - 래퍼는 명령이 main의 pipeline.yaml에서 왔는지 알 수 없다. 그 출처는 Runner가 지킨다. 래퍼는 실행 범위(계정·폴더·환경)를 막는다.
  - pnpm은 `install-agent-cli.sh`가 `/srv/agentwbs/cli/pnpm/<버전>`에 설치한다(Agent용 node에는 corepack이 없다).
- `run`이 넘겨받는 환경 변수는 `LANG`·`LC_ALL`뿐이다. 다른 이름(예: `GH_TOKEN`)은 거부한다.
- 설정 파일(`/etc/agentwbs/agent-exec.conf`)은 실행하지 않고, 정해진 이름만 한 줄씩 읽는다.
  - 왜: 설정 파일에 명령을 숨겨 두어도 실행되지 않게 한다.
- 래퍼와 설정 파일은 root 소유다. Runner도 Agent도 고칠 수 없다.
- 래퍼는 시작하자마자 현재 폴더를 루트(`/`)로 옮긴다.
  - 왜: sudo는 부른 쪽의 현재 폴더(예: `/home/keeproll`)를 그대로 물려준다. Agent는 그 폴더에 들어갈 수 없다.
  - 그 상태에서 GNU find(파일 찾기 명령)는 끝날 때 「처음 폴더로 돌아갈 수 없음」으로 실패한다. 그러면 `check`가 `cli_unverified`·`inputs_unverified`를 내고 `fix-perms`도 실패한다(owner 설치 1차 실패, fix6).
- `check`는 cli·inputs가 비어 있어도 그 항목을 실패로 보지 않는다. 「Agent가 하나도 쓸 수 없는가」만 본다.
  - 왜: 설치 순서가 「설치(2단계, 여기서 `check`) → CLI 설치(3단계)」라서 `check` 때는 CLI가 아직 없다.
  - CLI가 있는지는 확인 스크립트 7단계와 Runner 준비 점검이 따로 본다.

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
  - **작업 폴더는 `0770`으로 만든다.** `0700`(예: `mktemp -d`, 지금 `GitRepository`의 `mkdir`)으로 만들면 ACL 상한(mask, 이름 있는 항목 권한의 공통 상한)이 `---`가 된다.
    - 그러면 Agent 항목에 `rwx`가 적혀 있어도 실제 권한이 없다(Codex 리뷰 P2-5). 기본 ACL은 umask는 무시하지만 만들 때 준 권한 숫자는 넘지 못한다.
- `/srv/agentwbs/runtime/node/bin/node` — root 소유 `0755`. Agent용 node다.
  - 왜 복사하나: Runner의 node는 `~/.nvm`(Runner 홈 안)이라 Agent가 실행할 수 없다. Claude·Codex CLI는 node로 돈다.
  - node를 올리면 설치 스크립트를 다시 실행한다(같은 단계가 새 파일로 덮어쓴다).
- `/home/awbs-agent` — `0700`. Agent 로그인 정보와 `tmp/`(Agent의 `TMPDIR`)가 있다.

Agent 계정이 못 읽는 곳(확인 스크립트가 하나씩 시험한다):

- `/home/keeproll` 전체. 홈이 `0750`이고 Agent는 keeproll 그룹이 아니기 때문이다.
  - 그 안의 `~/.agentwbs`(`0700`), `~/.config/gh`, `~/.ssh`, `~/.orca`, `~/.claude`, `~/.codex`, `~/projects/verum-*`, `~/.config/verum-*`.
- `/mnt`(Windows 드라이브), `/run/WSL`(Windows 실행 통로), `/Docker`, `/var/run/docker.sock`.

### 6.1 WSL에서 Agent의 DNS(이름 찾기) — fix7·fix8

- **문제:** WSL은 `/etc/resolv.conf`를 `/mnt/wsl/resolv.conf`로 가는 링크로 만든다. `/mnt`는 Agent에게 통째로 막혀 있어서 Agent는 링크를 따라가지 못한다.
  - 그래서 Agent 계정의 Claude 로그인이 `getaddrinfo EAI_AGAIN platform.claude.com`으로 실패했다.
- **fix7(버림):** 링크가 바뀔 때마다 감시(systemd path)로 다시 사본을 만들었다.
  - 이 PC는 `wsl.exe`를 실행할 때마다 링크를 다시 만든다(0.4초에 3번까지 확인, 리뷰7).
  - systemd 감시는 서비스가 도는 동안의 변화를 놓치고, 10초에 5번 넘게 돌면 시작 한도에 걸려 멈춘다(리뷰7 P2-1).
  - 그래서 링크 재생성과 계속 싸우는 방식은 버렸다.
- **fix8 기본 방식(터널링):** 이 PC는 WSL DNS 터널링을 쓴다. DNS 주소가 `10.255.255.254`로 고정이다.
  1. 설치가 DNS 원본의 `nameserver`가 `10.255.255.254` **하나뿐인지** 확인한다.
  2. `/etc/wsl.conf`에 `[network]` `generateResolvConf = false`를 더한다. 다른 줄은 그대로 둔다.
     - 설치 전 모습은 `/etc/agentwbs/wsl.conf.before`에 한 번만 보관한다. 원래 없었으면 `wsl.conf.absent` 표시를 남긴다.
     - 설치가 쓴 모습은 `/etc/agentwbs/wsl.conf.installed`에 남긴다. 제거 때 그 뒤 owner가 고쳤는지 본다.
  3. `/etc/resolv.conf`를 그 내용의 **실제 파일**로 둔다(임시 이름에 쓴 뒤 `mv`로 한 번에 바꿈).
  4. 방식을 `/etc/agentwbs/dns-mode`에 `tunnel`로 적는다.
  - 왜 이 방식인가: WSL이 더 이상 링크를 만들지 않는다. 그래서 싸울 상대가 없다. 주소가 고정이라 실제 파일로 둬도 낡지 않는다.
  - **WSL 재시작이 꼭 필요하다:** Windows에서 `wsl --shutdown` 후 다시 열고 확인 스크립트로 「실제 파일 유지」를 확인한다. 재시작 뒤에도 유지되는지가 핵심이다.
  - Runner·owner에게 주는 영향: 같은 주소(`10.255.255.254`)에 묻는다. 확인 스크립트가 Runner DNS도 검사한다.
  - 남는 점: 검색 도메인(`search`)은 설치 때 값으로 고정된다. 이름 끝까지 쓰는 주소(예: `api.anthropic.com`)에는 영향이 없다.
- **fix9 보강(리뷰8 P2-1):** `generateResolvConf = false`는 재시작해야 적용된다. 설치와 재시작 사이에 `wsl.exe`가 돌면 WSL이 링크를 다시 만들고, 재시작 뒤 그 링크가 굳는다. 원본이 없으면 모든 계정의 DNS가 끊긴다.
  - **저장 사본:** 설치가 만든 `/etc/resolv.conf`를 `/etc/agentwbs/resolv.conf.installed`에 둔다.
  - **설치 다시 실행으로 복구:** 방식 기록이 `tunnel`이면 원본이 없어도 「원본 → 저장 사본 → 고정 주소 한 줄」 순서로 실제 파일을 다시 만든다.
  - **부팅 복구 서비스:** `awbs-agent-resolv-restore.service`가 부팅 때 한 번, `/etc/resolv.conf`가 링크일 때만(`ConditionPathIsSymbolicLink`) 저장 사본으로 실제 파일을 되살린다.
    - 도우미는 `/usr/local/libexec/awbs-resolv-restore`(root 소유)다.
    - 자동 생성이 꺼진 뒤라 WSL과 싸우지 않는다. 그래서 감시·타이머가 필요 없다.
    - 저장 사본은 root 소유 일반 파일이고, 첫 줄 표시와 nameserver(고정 주소 하나)가 맞을 때만 쓴다. 아니면 고정 주소 한 줄로 만든다.
  - **런북:** 설치 직후 바로 재시작하고(`wsl --shutdown`은 모든 WSL 배포판·Docker Desktop을 멈춤), 재시작 뒤 설치를 한 번 더 실행해 상태를 확정한다.
  - **wsl.conf 편집(리뷰8 P3-1):** 줄 끝 CR(윈도 줄바꿈)과 머리 뒤 주석(`[network] # …`)을 떼고 절을 알아본다. 그래서 절이 겹치지 않는다.
    - 확인은 `[network]` 절이 하나이고 그 안의 값이 모두 `false`일 때만 PASS다.
  - **기대는 것(리뷰8 P3-4):** Windows 쪽 DNS 터널링(기본으로 켜짐)이다. 꺼지면 `10.255.255.254`가 응답하지 않는다.
    - 확인 스크립트의 Runner DNS FAIL이 잡는다. 할 일은 제거 → 재시작 → 설치 다시 실행이다(런북 2-2단계).
    - `search` 도메인도 설치 때 값으로 고정된다.
- **fix8 대체 방식(사본):** `nameserver`가 고정 주소 하나가 아니면(예: NAT 모드의 바뀌는 주소) 설치가 ★로 크게 알리고 fix7 도우미를 쓴다.
  - 리뷰7 지적을 반영했다: 서비스 시작 한도 끔(`StartLimitIntervalSec=0`), 30초 시간 제한, 감시 뒤에 시작, **1분 타이머**(감시가 놓치거나 멈춰도 1분 안에 복구).
  - 도우미는 바꾼 뒤 1초 기다렸다가 다시 링크가 됐으면 다시 옮긴다(최대 5번).
  - 이 방식에서는 WSL이 링크를 다시 만들 때 Agent DNS가 최대 1분 끊길 수 있다.
- **도우미·설정 줄의 안전 규칙**(두 방식 공통)
  - 원본은 링크가 아닌 root 소유 일반 파일만 읽는다. 열 때도 링크를 따라가지 않는다(`dd iflag=nofollow`).
  - `nameserver`는 IP 주소 모양만, `search`·`domain`·`options`·`sortlist`도 값 모양을 본다.
  - `/etc/resolv.conf`가 WSL 링크이거나 이 설치가 만든 파일(첫 줄 표시)일 때만 바꾼다. owner가 직접 관리하는 파일은 건드리지 않는다(방식 `manual`).
- **제거:** 대체 방식 단위(타이머·감시 먼저)를 끄고, `/etc/wsl.conf`가 설치가 쓴 모습 그대로면 설치 전 모습으로 되돌린다.
  - 그 뒤 owner가 고쳤으면 되돌리지 않고 남은 항목으로 알린다(종료 코드 3).
  - `/etc/resolv.conf`는 원본이 있을 때만 WSL 링크로 한 번에 되돌린다(임시 이름 → `mv`). 원본이 없으면 파일을 그대로 두고 WSL 재시작을 안내한다.
  - `/etc/wsl.conf`를 되돌리지 못해 `generateResolvConf = false`가 남으면 링크로 되돌리지 않고, 부팅 복구 서비스도 남긴다(리뷰8 P3-2). 재시작 뒤 끊긴 링크가 굳지 않게 하려는 것이다.
- **고르지 않은 방법:** `/mnt`·`/mnt/wsl`에 Agent 「지나가기만」 허용 + 자식마다 차단. 드라이브(drvfs)는 0777이고 리눅스 ACL이 걸린다는 보장이 없다. 하나라도 빠지면 Windows 파일을 읽고 쓴다.

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
- 정리 순서(M8 전 연결에서 exec 계층에 연결함, `src/exec/README.md` 「전용 계정 + 사용자 scope 실행」):
  1. **세션마다 사용자 cgroup scope를 쓴다.** 실행은 `systemd-run --user --scope … -- sudo -n -u awbs-agent -- 래퍼 run …`이다. 정리할 때 그 scope의 `cgroup.kill`에 1을 쓴다.
     - cgroup(control group) = 프로세스 묶음별로 CPU·메모리를 재고 제한하는 리눅스 기능.
     - scope = 사용자 systemd가 프로세스 묶음에 붙이는 이름표. 커널에서는 cgroup 하나다. Runner 계정의 사용자 systemd가 만들므로 cgroup 파일이 Runner 소유다.
     - Runner가 만든 cgroup 안의 프로세스는 계정과 상관없이 커널이 한 번에 끝낸다. Agent는 다른 계정의 cgroup 파일을 쓸 수 없어 빠져나가지 못한다.
     - sudo는 Ubuntu에서 새 로그인 세션(pam_systemd)을 만들지 않으므로 Agent 프로세스는 scope에 그대로 남는다. 이 PC에서 실제로 확인했다(`test/exec/dedicated-scope.host.ts`: setsid·nohup·이중 fork·표식 지우기 자손 8개가 모두 같은 scope, 정리 뒤 0개).
     - scope를 만들 수 없으면(사용자 systemd 없음, linger 꺼짐) 실행을 거부한다. 2·3으로 대신하지 않는다.
       - 왜: `kill-group`은 그룹을 빠져나간 자손을 못 잡고, `kill-all`은 다른 세션까지 끝낸다. 둘 다 「이 세션이 끝났다」는 증거가 되지 못한다.
  2. 래퍼 `kill-group <pgid>`(`agentControl`)는 손으로 정리할 때 쓰는 보조 수단으로 남긴다. 제품 코드는 부르지 않는다.
     - Agent 계정으로 보내므로 그 그룹의 Agent 프로세스만 끝난다. Runner·root 프로세스에는 닿지 않는다.
  3. 래퍼 `kill-all`도 같은 보조 수단이다. Agent 계정의 모든 프로세스를 끝낸다.
     - 전용 계정이라 「이 계정의 프로세스 = Agent 실행」이다. 다른 세션이 돌고 있으면 그것도 끝나므로 세션이 0일 때만 쓴다.
- 작업 폴더를 지울 때 권한 문제(EACCES·EPERM)로 막히면 래퍼 `fix-perms <경로>`로 Agent 파일에 Runner 권한을 되돌린 뒤 한 번 더 지운다(`GitRepository.removeWorktree` → `restoreAgentPermissions`, M8 전 연결).
  - 지우는 동안 Runner 소유 폴더는 `0770`으로 둔다. `0700`으로 바꾸면 ACL 상한이 `---`가 되어 Agent 계정으로 도는 `fix-perms`가 그 폴더에 못 들어가 실패한다(실계정 시험에서 재현, 종료 코드 4).
  - Agent 소유 폴더는 Runner가 권한 숫자를 바꿀 수 없다(EPERM). 그 폴더는 `fix-perms`가 준 ACL로 들어가 지운다.
  - 왜: Agent가 자기 파일의 권한을 지우면(예: `chmod 000`) Runner가 지울 수 없다.
  - 순서: 그 세션의 Agent 프로세스가 0개인지 먼저 확인한다. 살아 있으면 고친 권한을 다시 지울 수 있다.
  - 폴더는 들어가기 전에 하나씩 바로 고친다. 그래서 `000`인 폴더가 겹겹이 있어도 한 번에 안쪽까지 되돌린다(Codex 리뷰 P2-8).
  - 하나라도 못 고치면 종료 코드 `4`다. 이때는 작업 폴더를 지웠다고 처리하지 않는다.

## 10. owner가 실행할 절차

- **실행 순서는 [OWNER-RUNBOOK.md](OWNER-RUNBOOK.md) 한 곳에만 적는다.** 이 절은 각 단계가 무엇을 하는지 설명한다(리뷰4 P3-4: 문서마다 순서가 달랐던 문제).
- 순서 요약: ① 미리 보기 → ② 설치 → ③ CLI 설치 → ④ Agent 계정 로그인 → ⑤ `.env` → ⑥ 확인 → ⑦ Runner 시작.
  - 왜 CLI 설치가 로그인보다 먼저인가: 로그인할 프로그램(`/srv/agentwbs/cli/.../current/bin/...`)이 있어야 한다.
  - 왜 로그인이 Runner 시작보다 먼저인가: Runner의 CLI 업데이트는 새 버전을 쓰기 전에 Agent 계정의 로그인 상태를 본다. 로그인이 없으면 업데이트를 적용하지 않는다.
- 모든 명령은 Runner 계정(keeproll)으로, 저장소 맨 위 폴더에서 bash로 실행한다. `sudo bash ...`로 부르지 않는다. 스크립트가 필요한 줄만 sudo로 실행한다.

### 10.1 미리 보기(아무것도 바꾸지 않음)

```bash
bash agent-runner/scripts/isolation/setup-agent-user.sh --dry-run
```

### 10.2 설치

```bash
bash agent-runner/scripts/isolation/setup-agent-user.sh
```

- 중간에 sudo 비밀번호를 묻는다.
- 옵션은 `--dry-run`과 `--node <경로>`뿐이다. 계정 이름·경로는 고정이다.
- 다시 실행해도 된다. 이미 있는 계정이 이 설치가 만든 계정(§4)일 때만 그대로 두고 권한·파일을 다시 맞춘다.
- 하는 일(순서대로, 스크립트 안에 한 줄씩 한글 주석):
  0. 관리자 권한 없이 먼저 검사한다. root가 다룰 고정 경로 중 하나라도 링크이거나 예상 밖 소유자이면 sudo를 한 번도 부르지 않고 멈춘다.
  1. 기존 sudoers 규칙을 먼저 지운다(닫고 시작).
  2. `acl` 패키지 설치(없을 때만).
  3. `awbs-agent` 계정 만들기(진행 기록 → 계정 → UID 기록, §4), 비밀번호 잠금.
     - Agent 홈 안(`chmod 0700`, `tmp/` 만들기, git 설정)은 **Agent 계정 권한으로** 한다.
     - 왜: Agent는 자기 홈 안에 링크를 심을 수 있다. root가 그 링크를 따라가면 시스템 폴더의 소유자·권한이 바뀐다(Codex 리뷰 P1-1).
  4. WSL이면 `/mnt`·`/Docker`·`/run/WSL`에 Agent 차단 ACL(`setfacl -P`: 링크는 따라가지 않음), 부팅 때 `/run/WSL`을 다시 막는 서비스 등록.
     - 4-1단계 Agent DNS(§6.1): 터널링이면 `/etc/wsl.conf` `generateResolvConf = false` + `/etc/resolv.conf` 실제 파일. 아니면 대체 방식(도우미·감시·타이머). 실패하면 여기서 멈춘다(닫힘).
  5. `/srv/agentwbs` 폴더와 권한, Agent용 node 복사.
  6. 래퍼·설정 파일 설치(root 소유).
  7. 래퍼 `check`를 Agent 계정으로 돌려 `ok`인지 본다.
  8. **맨 마지막에** sudoers 규칙 설치(먼저 `visudo -c`로 문법 검사).
- 중간에 실패하면 trap(스크립트가 끝날 때 반드시 도는 정리 코드)이 sudoers 규칙을 지운다. Windows 차단은 걸린 그대로 둔다.
  - 왜: 설치가 실패했을 때는 덜 허용하는 쪽(닫힘)으로 끝나야 한다(Codex 리뷰 P2-4).
- root가 다루는 경로는 모두 고정 절대 경로이고, 그 상위 폴더는 root나 Runner만 쓸 수 있다. 그래서 검사한 뒤 실행하기 전에 Agent가 링크를 바꿔치기할 틈(TOCTOU)도 없다.

### 10.3 Runner 설정

`agent-runner/.env`에 아래 한 줄을 넣는다.

```bash
AWBS_AGENT_USER=awbs-agent
```

- 값은 `awbs-agent`만 받는다. 다른 이름이면 설정 오류로 실제 실행을 만들지 않는다.
- 작업 영역(`/srv/agentwbs`)·래퍼(`/usr/local/libexec/awbs-agent-exec`) 경로는 고정이다. 예전처럼 `AWBS_AGENT_ROOT`·`AWBS_AGENT_EXEC`를 적었다면 고정값과 같을 때만 받아들인다.
- 이 줄을 넣으면 Runner가 다음을 바꾼다(isolation.md §12에서 연결함).
  - CLI 설치·갱신 위치: `~/.agentwbs/cli` → `/srv/agentwbs/cli`(폴더 권한 0750: Agent는 읽기·실행만).
  - 작업 폴더·입력 사본 위치: `~/.agentwbs/worktrees`·`inputs` → `/srv/agentwbs/worktrees`·`inputs`. bare 저장소·상태·비밀값은 그대로 Runner 홈에 있다.
  - CLI 로그인 상태 확인: Runner 계정이 아니라 Agent 계정으로(래퍼 `login-status`).
  - 주의: 이미 `~/.agentwbs/worktrees`에 작업 폴더가 있으면 옮겨지지 않는다. 실제 작업을 시작하기 전에 바꾼다(지금은 작업 폴더가 없다).
- `AWBS_AGENT_USER`가 비어 있으면 Runner는 지금처럼 실제 실행 계획을 만들지 않는다(`isolation_undecided`).
- 넣어도 래퍼 `check`가 `ok`를 내야만 전용 계정을 쓴다(`selectIsolation`).
  - 왜: 설정만 믿으면 sudoers·래퍼·WSL 보호가 빠진 PC에서 격리된 줄 알고 실행하게 된다.
- 작업 폴더·CLI 경로 비교는 대상과 기준 폴더를 **둘 다** 실제 경로(realpath)로 바꾼 뒤에 한다(Codex 리뷰 P2-3).

### 10.4 CLI 설치와 Agent 계정 로그인(한 번)

- CLI 설치: `bash agent-runner/scripts/isolation/install-agent-cli.sh`
  - npm 공식 저장소의 latest 버전을 `/srv/agentwbs/cli/<claude|codex>/<버전>/`에 설치하고 `current` 링크를 건다(owner Q-12 「항상 최신」).
  - Runner 계정으로 돈다(sudo 없음). 이 폴더의 주인이 Runner 계정이기 때문이다.
  - 설치한 프로그램이 그 버전을 말하는지(`--version`)만 확인한다. 돈이 드는 호출은 없다.
  - 그 뒤 갱신은 Runner가 한다: 시작할 때와 매일 최신 버전을 확인하고, 실행 중인 세션이 없을 때 바꾼다(architecture §5.1). Runner를 오래 꺼 두었으면 Runner를 멈춘 채 이 스크립트를 다시 돌려도 된다.
- 로그인 명령과 화면에서 할 일은 [OWNER-RUNBOOK.md](OWNER-RUNBOOK.md) 4단계에 있다.
- 로그인 정보는 `/home/awbs-agent/.claude`·`.codex`에 저장된다. Runner 계정의 로그인과 따로다.
- 브라우저가 자동으로 열리지 않는다. Agent 계정은 Windows 프로그램을 실행할 수 없기 때문이다(§6). 주소를 직접 복사한다.
- 로그인은 돈이 들지 않는다. 모델 호출은 하지 않는다.

### 10.5 설치 후 확인

```bash
bash agent-runner/scripts/isolation/check-agent-user.sh
# 다른 비밀 폴더도 시험하려면 --protect를 더한다.
bash agent-runner/scripts/isolation/check-agent-user.sh --protect /home/keeproll/projects/verum-sdn
```

- 줄마다 `PASS`·`FAIL`·`WARN`이 나온다. `FAIL`이 하나라도 있으면 종료 코드 1이다. 마지막 줄에 항상 `결과: FAIL n개`가 나온다.
- **확인하지 못한 검사는 FAIL이다(fail-closed).**
  - 예: sudo 비밀번호가 틀려 Agent로 해 보지 못했으면 「막혔다」가 아니라 `FAIL 확인 못 함`이다.
  - 그래서 Agent로 아무 명령이나 실행되는지(양성 대조)를 먼저 보고, 안 되면 거기서 멈춘다.
- 확인 항목:
  - 계정: 설치 기록 UID·홈·셸(nologin)·전용 그룹과 일치, 다른 그룹(sudo·docker 등) 소속 없음.
  - sudo 정책: `sudo -l -U <Runner>`가 보여 주는 허용 목록을 **느슨하게 해석하지 않고 글자 그대로** 맞춰 본다(Codex 재리뷰 P2-A).
    - 규칙 줄은 두 가지만 허용한다.
      - `(awbs-agent) NOPASSWD: /usr/local/libexec/awbs-agent-exec` — 정확히 1번.
      - owner의 관리자 규칙(비밀번호 필요). 흔한 표기 `(ALL : ALL) ALL`·`(ALL:ALL) ALL`·`(ALL) ALL`·`(root) ALL`·`(… ) PASSWD: ALL`을 인정한다. `%sudo` 그룹 경유와 직접 규칙이 겹쳐 여러 번 나와도 된다(Codex 3차 P3).
    - 비밀번호 없는 관리자 규칙(`(ALL : ALL) NOPASSWD: ALL` 등)은 「관리자 규칙(비밀번호 없음)」으로 알아보고 WARN 한 줄을 낸다. 종료 코드에는 영향이 없다. PASS로 세지도 않는다.
      - 문구: 「Runner 계정이 비밀번호 없이 root가 될 수 있어, Agent 격리가 뚫리면 피해가 커집니다. 원하면 NOPASSWD를 빼세요.」
      - 왜 FAIL이 아닌가: Agent 계정이 Runner 계정으로 넘어오는 경계와는 별개인 owner 자신의 선택이기 때문이다. 다만 검사를 느슨하게 하지 않기 위해 PASS로는 만들지 않는다.
    - Agent 래퍼 규칙은 그대로 글자 그대로 일치해야 한다(공백 하나만 달라도 FAIL).
    - 그 밖의 규칙 줄은 모두 FAIL이다. 예: `(root) NOPASSWD: /bin/bash`, 경로 와일드카드, `NOPASSWD: SETENV:`, `PASSWD:`가 섞인 줄, 별칭 이름, 비밀번호가 필요한 다른 규칙.
    - 기본값 줄은 알려진 항목(`env_reset`, `mail_badpass`, `use_pty`, Ubuntu 기본 `secure_path`)만 허용한다. 다른 항목(예: `!authenticate`, `env_keep`, `setenv`, 바뀐 `secure_path`)이 하나라도 있으면 FAIL.
    - 모르는 머리말(예: 명령별 기본값)이나 위치를 알 수 없는 줄도 FAIL(확인 못 함).
    - owner PC에서 처음 FAIL이 나오면 그 줄을 그대로 보고한다. 이 PC의 실제 `sudo -l` 형식은 실행 금지 조건 때문에 아직 확인하지 않았다.
  - 설치된 sudoers 파일(`/etc/sudoers.d/awbs-agent`)이 설치 원본과 글자 그대로 같은지도 본다(owner의 sudo로 읽음).
    - 왜 실행해 보지 않나: root로 실행이 허용돼도 래퍼가 「Agent 계정이 아님」으로 스스로 실패한다. 실행 결과로는 허용 여부를 알 수 없다(Codex 리뷰 P2-6).
  - 비밀번호 없이 래퍼가 실제로 돌고 래퍼 점검이 `ok`.
  - 못 읽는 곳: Runner 홈, `~/.agentwbs`, `~/.config/gh`, `~/.ssh`, `~/.orca`, `~/.claude`, `~/.codex`, `~/projects/verum-*`, `~/.config/verum-*`, 그리고 `--protect` 경로. 목록 읽기와 지나가기를 따로 본다.
  - WSL: `/mnt`와 그 아래 **모든** 항목(드라이브 c·d·x 등, `wsl`·`wslg`, `/mnt/wsl` 안쪽), `/run/WSL`·`/Docker`·`/Docker/host`의 목록 읽기와 지나가기를 따로 본다(fix7: 이름을 고정하지 않고 지금 있는 것을 모두).
  - DNS(fix8): `/etc/resolv.conf`가 링크가 아닌지, 터널링 방식이면 `/etc/wsl.conf` 설정과 nameserver, Runner·Agent 양쪽이 `api.anthropic.com`을 찾는지 본다. `/mnt/wsl/resolv.conf` 원본은 Agent가 여전히 못 읽는지도 본다.
    - Runner도 못 찾으면 FAIL이다(설정을 바꾼 뒤 owner·Runner 네트워크가 멀쩡한지도 확인해야 하므로).
  - Windows 실행: 진짜 Windows 프로그램(`whoami.exe`) 복사본을 Agent로 실행해 보고 막히는지 본다.
    - 복사본은 Runner만 쓸 수 있는 폴더(`0700`)에 먼저 복사하고, 그다음 Agent가 읽고 실행만 하게 연다(`0750`).
    - Runner로는 돌고(대조), Agent가 복사본을 읽고 실행할 권한도 있다는 것을 확인한 뒤에만 「막힘」을 PASS로 센다(Codex 리뷰 P2-5).
  - Docker 소켓 읽기·쓰기 못 함.
  - 작업 영역: CLI 설치본과 입력 자료는 **안쪽 파일·폴더까지** 하나도 못 고침(Codex 리뷰 P2-7), 작업 폴더(`0770`) 안에 쓰고 Runner가 다시 지울 수 있음.
  - 로그인 상태(`auth status`·`login status`, 돈 안 듦). 로그인 안 됨은 경고만.
  - 참고: `/tmp`에 Runner 계정의 공개 파일이 있으면 경고. 다른 계정의 비공개 폴더 때문에 검색이 오류를 내도 멈추지 않는다(Codex 리뷰 P3-10).
- 확인은 아무것도 고치지 않는다.

### 10.6 되돌리기

```bash
bash agent-runner/scripts/isolation/remove-agent-user.sh --dry-run        # 보기만
bash agent-runner/scripts/isolation/remove-agent-user.sh                  # 계정·래퍼·규칙 제거(작업 영역은 남김)
bash agent-runner/scripts/isolation/remove-agent-user.sh --purge-work     # 작업 영역까지 삭제
```

- Runner를 먼저 멈춘다.
- 옵션은 `--dry-run`과 `--purge-work`뿐이다. 계정 이름·경로는 고정이다.
- 순서(왜 이 순서인가):
  1. sudoers 규칙·래퍼·설정을 먼저 지운다. 정리하는 동안 새 세션이 뜨지 않는다.
  2. 기록한 UID의 프로세스를 끝내고 0개인지 확인한다. 종료 명령 오류는 「없음」으로 치지 않는다.
  3. 계정을 지운다(로그인 정보도 함께).
  4. **그 뒤에야** Windows 차단을 푼다. 숫자 UID로 지운다(계정 이름은 이미 없으므로).
     - Agent DNS 설정(§6.1)도 되돌린다. `/etc/wsl.conf`는 설치 전 사본으로, `/etc/resolv.conf`는 WSL 링크로.
  5. 작업 영역을 남기는 경우에도 Agent 흔적을 남김없이 지운다. ACL(이름·숫자·기본)을 모두 지우고, Agent가 소유했던 파일은 Runner 소유로 바꾼다.
     - 왜: 나중에 같은 숫자 UID가 다른 계정에 배정되면 남은 파일에 접근할 수 있다(Codex 리뷰 P2-9).
  6. 마지막에 UID 기록과 진행 기록을 지운다.
- 기록이 하나도 없어도 생성 표식이 있는 우리 계정이면 그 계정의 UID로 정리한다. 표식이 없는 같은 이름 계정은 건드리지 않는다.
- **UID는 단계마다 다시 확인한다**(Codex 3차 P2). 기록의 UID는 「설치가 쓰려던 번호」일 뿐이라, 그 사이 다른 계정에 배정됐을 수 있기 때문이다.
  - 어디서 얻은 UID든(UID 기록·진행 기록·계정) 시스템 계정 범위(1~999)가 아니면 시작하지 않는다.
  - 프로세스 종료·계정 삭제 직전: 그 UID가 지금도 `awbs-agent`이고 생성 표식이 같아야 한다.
  - 숫자 권한 항목 삭제·소유권 정리 직전: 그 UID를 지금 아무 계정도 쓰지 않아야 한다.
  - 계정이 이미 지워졌으면 UID로 프로세스를 끝내지 않는다. 남은 프로세스가 있는지만 읽어서 본다.
  - 하나라도 맞지 않으면 그 단계는 건너뛰고, 다른 계정은 건드리지 않는다.
  - 이때는 작업 영역 정리(ACL 지우기·그룹 바꾸기·`--purge-work` 삭제)도 하지 않는다(리뷰4 P3-2). 숫자로 남은 옛 Agent 파일이 지금은 다른 계정의 파일일 수 있기 때문이다.
  - 끝에 「남은 항목」 목록을 보여 주고 종료 코드 `3`으로 끝난다. 기록은 남겨 둔다.
- 설치 중 되돌리기(진행 기록으로 계정 지우기)도 계정·그룹 삭제가 하나라도 실패하면 성공으로 표시하지 않는다. 남은 항목을 보여 주고 진행 기록을 남긴다(Codex 3차 P3).
- 중간에 실패하면 Windows 차단은 걸린 그대로 남는다(Codex 리뷰 P2-4). 원인을 고친 뒤 같은 명령을 다시 실행하면 기록한 UID로 이어서 정리한다.
- 같은 이름의 계정이 이 설치가 만든 계정이 아니면 아무것도 지우지 않는다.
- 작업 영역 실제 경로가 고정 경로(`/srv/agentwbs`)와 다르거나(링크 등) Runner 홈과 겹치면 멈춘다.
- `.env`의 `AWBS_AGENT_USER` 줄도 지운다. 그러면 Runner는 다시 실제 실행을 거부한다.

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
- **확인 직후 상태가 바뀌는 짧은 틈(경합)이 남는다**(리뷰4 P3-1).
  - 제거 스크립트는 프로세스를 끝내기 직전마다 「그 UID가 지금도 `awbs-agent`인가」를 본다. 그 확인과 실제 종료 명령(`pkill -U <UID>`) 사이는 아주 짧지만 비어 있다.
  - 이 틈을 쓰려면 root가 그 순간에 `awbs-agent`를 지우고 같은 번호로 다른 계정을 만들어야 한다. 계정이 있는 동안 같은 번호의 새 계정은 만들 수 없고, Agent 계정은 계정 정보를 바꿀 권한이 없다.
  - 계정 삭제(`userdel`)도 같은 구조다. 그래서 위험은 낮다고 보고 고치지 않고 남긴다.
  - 줄이는 방법(제안): 숫자 대신 계정 이름으로 신호 보내기(`sudo -u awbs-agent -- kill -KILL -1`). 이름을 번호로 바꾸는 일과 신호가 한 명령 안에서 일어난다.
- **`/tmp`·`/var/tmp`·`/dev/shm`에 Agent가 만든 파일은 제거 뒤 숫자 UID로 남는다.** 제거 스크립트는 이 공용 폴더를 지우지 않는다(다른 계정 파일과 섞여 있기 때문). 재부팅하면 `/tmp`·`/dev/shm`은 비워진다.
- **Agent가 작업 폴더의 git 설정을 바꿀 수 있다.** 그래서 Runner 계정 git은 그 폴더에서 돌지 않는다(fix2, 조정자 결정 6).
  - 작업 폴더 준비는 Runner 전용 준비 폴더(0700)에서 끝낸 뒤 넘기고, HEAD·상태는 래퍼 `git-inspect`, 결과는 래퍼 `git-bundle`(Agent 계정)로만 받는다. 자세한 것은 `src/git/README.md` 「전용 계정 배치의 경계」.
- **알려진 남은 위험(조정자 결정 9, 재점검 P2-2): 같은 전용 계정 안의 다른 Task Agent는 검사 사본에 쓸 수 있다.**
  - 무엇이 가능한가: 모든 Task가 같은 awbs-agent 계정을 쓴다. 다른 Task의 Agent가 `/proc`(예: 다른 프로세스의 `cwd`·명령 인자)로 검사 사본 경로를 알아내면, 그 사본의 파일을 바꿀 수 있다.
  - 0710(목록 숨김)은 경로 짐작을 어렵게 할 뿐이다. `/proc`로 알아내는 것은 막지 못한다.
  - 왜 받아들이나: 같은 프로젝트의 Agent끼리는 같은 신뢰 영역으로 본다. 막으려면 Task마다 다른 OS 계정이나 mount namespace가 필요하고, 이것은 Q-08 범위 밖이다.
  - 그래서 유지하는 대조: Runner는 결과를 Agent 폴더에서 직접 믿지 않는다. 결과 커밋은 bundle verify·fetch(객체 fsck)로만 받고, 검사는 고정 커밋으로 새로 만든 사본에서 하며, 실행 전후 HEAD·상태(`git-inspect`)를 대조한다.
  - 이 대조로도 「다른 Task Agent가 같은 계정으로 검사 중인 사본을 바꿔 시험 결과를 흔드는 것」은 완전히 막지 못한다(같은 계정 안 무결성). 이것이 받아들인 범위다.
- **래퍼 호출이 멈추지 않게(재점검 P2-1, fix3)**: Agent 설정(filter 등)이 띄운 `setsid` 자손이 출력 통로를 쥐어도 Runner는 멈추지 않는다.
  - 래퍼 호출마다 전용 사용자 scope가 있다. 시간 초과(기본 10분)면 그 scope를 `cgroup.kill`로 비우고 통로를 닫은 뒤 「시간 초과」로 실패한다.
  - 명령은 끝났는데 자손이 통로를 쥐고 남으면(2초) scope를 비우고 결과를 쓰지 않고 실패한다.
- **래퍼는 Runner를 막는 경계가 아니다.** Runner 계정을 Agent 계정으로 바꾸는 「문」이다. `ci-run`은 고정 PATH의 아무 명령이나 받는다. 결정 4(「`run`은 진입점만」)는 `run` 안의 규칙일 뿐이다.
- **하위 Agent 정의 설치(`exec/install.ts`)**: 전용 계정 배치에서는 래퍼 `agent-file`(Agent 계정)로만 읽고·쓰고·지운다(fix2 추가). Runner 계정은 Agent가 쓸 수 있는 폴더에 쓰지 않는다. 같은 계정 배치(개발·시험)만 직접 쓴다.

## 12. 후속 연결 작업

### 12.1 이번에 연결함(fix4)

1. **작업 폴더·입력 사본 위치**: `AWBS_AGENT_USER=awbs-agent`이면 `GitRepository`가 `worktrees/`·`inputs/`를 `/srv/agentwbs` 아래에 만든다(`GitLayout.agentRoot`).
   - 작업 폴더 모음(`worktrees/<저장소>`)·입력 모음은 0750: Agent 그룹은 들어가기만, 맨 위는 못 바꾼다.
   - 작업 폴더는 0770으로 만들고, checkout한 파일·폴더에 그룹 쓰기를 준다. 그래야 기본 ACL의 Agent 항목이 효과를 가진다(§6).
   - bare 저장소(`repos/`)·상태(`state/`)는 그대로 Runner 홈(0700)에 있다.
2. **CLI 설치 위치**: 같은 조건에서 CLI 업데이트(`cli-update`)가 `/srv/agentwbs/cli`에 0750 폴더로 설치·갱신한다. 처음 설치는 `install-agent-cli.sh`(§10.4).
3. **준비 점검·CLI 업데이트의 로그인 확인**: Runner 설치본 CLI의 로그인 상태 질의만 래퍼 `login-status`로 Agent 계정에서 돈다(`agentLoginRun`). 다른 명령(`--version` 등)은 그대로 Runner 계정에서 돈다.

### 12.2 M8 전 연결에서 연결함

4. **exec 계층(M5-02)**: `RunnerApp`이 준비 점검 뒤·매일·실행 직전마다 `selectIsolation`(래퍼 `check` + 사용자 scope 시험)을 부른다. 통과하면 세션을 「전용 계정 + 사용자 scope」로 띄우고, 정리는 scope의 `cgroup.kill`로 한다(§9). 작업 폴더 삭제는 막히면 `fix-perms`를 쓴다.
   - `AWBS_AGENT_USER`가 없으면 지금처럼 실행을 거부한다.
   - 실제 시도 흐름은 결과 수집기(`collect`)가 연결돼야 돈다. 이 수집기는 아직 없다(`src/jobs/README.md`).

### 12.3 아직 남음

5. **CI**: fix1에서 연결함. ①·②·재실행 명령은 래퍼 `ci-run`으로 Agent 계정·사용자 scope에서 돈다(§5.1, 조정자 결정 1). 래퍼 `run`은 claude·codex 진입점만 받는다(결정 4).
   - **계약 추출·임시 SQL**은 아직 이 경계를 쓰지 않는다(그 실행기가 앱에 연결되지 않았다). 연결할 때 `ci-run`과 같은 `Execution.command`를 쓴다.
6. **`importWorktree`의 계정 간 안전성**(§11) 재검토.

## 13. 시험

```sh
pnpm -C agent-runner test -- cli
```

- `test/cli/dedicated-user.test.ts`: 「계정이 있다고 가정한」 명령 구성. 실제 계정·sudo 없이 실행 계획 모양만 본다. scope 시험 명령과 「systemd-run … -- sudo …」 모양도 본다.
- `test/exec/dedicated-scope.host.ts`(`pnpm -C agent-runner test:host`): **설치된 PC에서** 실제 래퍼·sudoers·awbs-agent 계정으로 돈다. 유료 호출 없음.
  - fake 세션: Codex 묶음의 `bwrap`으로 `kernel-tree.py`(setsid·nohup·이중 fork·표식 지우기 자손)를 띄운다. 모든 프로세스가 awbs-agent·같은 scope 안인지, Runner의 직접 신호가 EPERM인지, 중단·정상 종료 뒤 Agent 프로세스가 0개인지 본다.
  - 작업 폴더 삭제: Agent가 `chmod 000`한 폴더를 `fix-perms`로 되돌린 뒤 지운다.
  - 실제 CLI는 `--version`만 부른다.
  - 래퍼나 계정이 없는 PC에서는 건너뛰고 그 사실을 증거 파일에 적는다.
- `test/cli/agent-exec.test.ts`: 래퍼를 실제 bash로 돌린다.
  - 설정 파일 경로만 시험 폴더로 바꾼 사본을 쓰고, 「Agent 계정」은 시험을 돌리는 계정으로 둔다.
  - sudo 자리에는 fake sudo를 둔다. 인자 모양(`-n -u <계정> --`)을 확인하고 환경을 비운 뒤 실행한다.
  - CLI·입력 안쪽 파일 쓰기 가능, 안쪽 폴더 읽기 불가, 겹친 `000` 폴더의 `fix-perms`, 설정 값의 다른 표기(`//`)를 재현한다.
- `test/cli/isolation-scripts.test.ts`: 설치·되돌리기·확인 스크립트를 **가짜 루트 폴더 + 가짜 sudo·getent**로 실제 bash에서 돌린다.
  - 시험 모드는 `AWBS_ISOLATION_TEST_ROOT`가 있고, 그 아래 `bin/sudo`(가짜)가 PATH 맨 앞일 때만 켜진다. 아니면 스크립트가 바로 멈춘다.
  - 가짜 sudo는 받은 인자를 기록하고, 정한 규칙대로 출력·종료 코드를 돌려준다. root 명령의 경로가 가짜 루트 밖이면 99로 끝나 시험이 실패한다.
  - Codex 리뷰 재현: Agent 홈의 링크, root 대상 경로의 링크·예상 밖 소유자, 다른 계정·root 옵션, 중간 실패 시 닫힘, 종료 실패 시 Windows 차단 유지, 숫자 UID 정리, sudo 정책의 root 허용, 확인 못 한 검사, Windows 시험 복사본 권한, `/tmp` 검색 오류.
  - 리뷰4 재현: 예약 실행(cron·at) 막기·검사·정리, UID 확인 실패 시 작업 영역 정리 건너뜀, `install-agent-cli.sh`(가짜 npm: 최신 설치·갱신·점검 실패·잘못된 버전).
- `test/git/git.test.ts`: `agentRoot`를 주면 작업 폴더·입력 사본이 Agent 작업 영역 아래에 생기고, 작업 폴더는 0770·파일은 그룹 쓰기 가능.
- `test/cli-update/manager.test.ts`·`test/config.test.ts`: CLI 폴더 0750, `AWBS_AGENT_USER` → `agentRoot`.
- 스크립트 검사: `bash -n`(문법)과 shellcheck(셸 스크립트 검사 도구) 0.10.0.

## 용어집

- **ACL(권한 목록)**: 소유자·그룹 말고도 특정 계정에 권한을 따로 적는 기능. `setfacl`로 쓰고 `getfacl`로 본다.
- **기본 ACL**: 폴더에 걸어 두면, 그 안에 새로 만드는 파일·폴더에 자동으로 붙는 ACL.
- **allowlist(허용 목록)**: 목록에 있는 것만 통과시키는 방식. 반대는 「막을 것만 적는」 방식.
- **bare 저장소**: 작업 파일 없이 git 기록만 보관하는 저장소.
- **cgroup(control group)**: 프로세스 묶음별로 CPU·메모리를 재고 제한하고, 묶음째 끝낼 수 있는 리눅스 기능.
- **cgroup.kill**: cgroup 폴더의 파일. 1을 쓰면 커널이 그 묶음의 모든 프로세스를 계정과 상관없이 강제 종료한다.
- **scope(사용자 scope)**: 사용자 systemd(`systemd-run --user --scope`)가 프로세스 묶음에 붙이는 이름표. 커널에서는 cgroup 하나다.
- **linger**: 로그아웃·재시작 뒤에도 그 계정의 사용자 systemd를 띄워 두는 설정(`loginctl enable-linger <계정>`). 꺼져 있고 아무도 로그인하지 않으면 scope를 만들 수 없다.
- **좀비 프로세스**: 끝났지만 부모가 아직 거두지(회수하지) 않은 프로세스. 거둘 때까지 프로세스 그룹에 남아 보인다.
- **CLI sandbox**: CLI 프로그램이 스스로 건드릴 수 있는 파일·네트워크 범위를 막는 기능.
- **dry-run**: 실제로 바꾸지 않고 무엇을 할지 보여 주기만 하는 실행.
- **fail-closed**: 확인하지 못하면 「안전하지 않음」으로 치는 방식. 반대로 확인 못 한 것을 통과시키면 위험을 숨긴다.
- **EPERM**: 「권한 없음」 오류. 다른 계정의 프로세스에 신호를 보내면 난다.
- **env(환경 변수)**: 프로그램에 넘기는 설정 값. 예: `HOME`, `PATH`.
- **mask(ACL 상한)**: 이름 있는 사용자·그룹 항목에 줄 수 있는 권한의 공통 상한. 폴더를 `0700`으로 만들면 `---`가 된다.
- **DNS(이름 찾기)**: `api.anthropic.com` 같은 이름을 IP 주소로 바꾸는 일. 리눅스는 `/etc/resolv.conf`에 적힌 DNS 서버에 묻는다.
- **resolv.conf**: DNS 서버 주소(`nameserver`)와 검색 도메인(`search`)을 적는 설정 파일.
- **systemd path 단위**: 파일이 바뀌는 것을 지켜보다가 정해진 서비스를 실행하는 systemd 기능.
- **drvfs**: WSL이 Windows 드라이브(`C:` 등)를 `/mnt/c`처럼 붙일 때 쓰는 파일 시스템.
- **interop(WSL)**: WSL 안에서 Windows 프로그램(.exe)을 실행하게 해 주는 기능. 실행된 프로그램은 Windows 사용자 권한으로 돈다.
- **nologin**: 로그인을 거부하는 셸. 계정은 있지만 사람이 들어와 명령을 칠 수 없다.
- **NOPASSWD**: sudoers에서 「비밀번호를 묻지 않는다」는 표시.
- **TOCTOU**: 검사한 뒤 실제로 쓰기 전 사이에 대상을 바꿔치기하는 경합.
- **trap**: 스크립트가 끝날 때(실패 포함) 반드시 도는 정리 코드.
- **UID**: 운영체제가 계정을 구분하는 숫자. 계정을 지워도 파일 권한에는 숫자로 남는다.
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
