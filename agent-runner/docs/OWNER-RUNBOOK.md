# Agent 전용 계정 설치 — owner 실행 순서 (한 장)

이 문서는 owner가 직접 실행할 명령을 **순서대로** 적은 한 장입니다.
설계와 이유는 [isolation.md](isolation.md)에 있습니다. 실행 순서는 이 문서만 따릅니다.

## 시작 전에 꼭 읽기

- 모든 명령은 **Runner 계정(keeproll)** 으로, **bash** 로 실행합니다.
  - `sh ...`로 부르지 마세요. 이 PC의 `sh`는 dash라서 스크립트가 「bash로 실행하세요」를 내고 멈춥니다.
  - `sudo bash ...`로 부르지 마세요. 스크립트가 필요한 줄만 안에서 sudo로 실행합니다. 처음 sudo를 쓸 때 비밀번호를 묻습니다.
- 모든 명령은 **저장소 맨 위 폴더**에서 실행합니다. 먼저 아래를 한 번 실행합니다.

  ```bash
  cd ~/orca/workspaces/agent-wbs/agent-isolation   # 병합 뒤에는 agent-wbs 저장소의 맨 위 폴더
  ls agent-runner/scripts/isolation                 # setup-agent-user.sh 등이 보이면 맞는 폴더
  ```

- Runner가 켜져 있으면 먼저 끕니다(Runner 터미널에서 `Ctrl+C`).
- 명령마다 화면 출력을 파일로도 남깁니다. 아래 명령들은 `tee`로 `~/awbs-setup-logs/`에 저장하고, 마지막 줄에 `exit=숫자`(종료 코드)를 보여 줍니다.

  ```bash
  mkdir -p ~/awbs-setup-logs
  ```

### 실패했을 때 보내 줄 것(모든 단계 공통)

1. 실행한 명령 한 줄
2. 화면에 나온 내용 전체(또는 그 단계의 로그 파일 `~/awbs-setup-logs/<단계>.log`)
3. 마지막 `exit=숫자` 줄

같은 명령을 다시 실행해도 됩니다. 각 스크립트는 이미 된 부분은 건너뛰고, 실패하면 「닫힌」 쪽(Agent가 실행되지 않는 쪽)으로 멈춥니다.

---

## 1단계. 미리 보기(아무것도 바꾸지 않음)

```bash
bash agent-runner/scripts/isolation/setup-agent-user.sh --dry-run 2>&1 | tee ~/awbs-setup-logs/1-dry-run.log; echo "exit=${PIPESTATUS[0]}"
```

- **하는 일:** 설치가 실행할 관리자 명령과 만들 파일(sudoers 규칙 한 줄 등)을 보여 주기만 합니다. sudo를 쓰지 않습니다.
- **성공이면:** 끝에 `(dry-run이라 아무것도 바꾸지 않았습니다.)`와 `exit=0`이 보입니다.
- **확인할 것:** `Runner 계정: keeproll`, `Agent 계정: awbs-agent`, `WSL 여부: 예`가 맞는지 봅니다.

## 2단계. 설치(관리자 권한, 비밀번호를 물음)

```bash
bash agent-runner/scripts/isolation/setup-agent-user.sh 2>&1 | tee ~/awbs-setup-logs/2-setup.log; echo "exit=${PIPESTATUS[0]}"
```

- **하는 일(순서대로):**
  1. 기존 「비밀번호 없는 실행 규칙」을 먼저 지웁니다(설치 중에는 닫아 둠).
  2. ACL 도구(`acl` 패키지)가 없으면 설치합니다.
  3. `awbs-agent` 계정을 만듭니다(로그인 셸 없음, 비밀번호 잠금, sudo 없음).
  4. 이 계정의 예약 실행(cron·at)을 막습니다.
  5. 이 계정만 Windows 드라이브(`/mnt`)·Windows 프로그램 실행 통로(`/run/WSL`)에 못 들어가게 막습니다.
     - `/mnt`가 막히면 WSL의 DNS 설정(`/mnt/wsl/resolv.conf`)도 못 읽습니다. 그래서 DNS 터널링(주소 `10.255.255.254` 고정)이면 `/etc/wsl.conf`에 `generateResolvConf = false`를 더하고(설치 전 모습은 보관) `/etc/resolv.conf`를 실제 파일로 둡니다.
     - 터널링이 아니면 ★★★ 표시와 함께 대체 방식(도우미 + 1분 타이머)을 씁니다. 이 표시가 보이면 알려 주세요.
  6. Agent 작업 영역 `/srv/agentwbs`(cli·inputs·worktrees)와 Agent용 node를 만듭니다.
  7. 실행 래퍼를 설치하고 Agent 계정으로 점검(`check`)합니다.
  8. 점검이 `ok`일 때만 마지막에 sudoers 규칙 한 줄을 넣습니다.
- **성공이면:** `래퍼 점검: ok`, `== 끝. 다음에 owner가 할 일`, `exit=0`이 보입니다.
- **실패하면:** 종료 코드가 0이 아니고, 「설치가 중간에 멈췄습니다 … 닫힌 상태로 둡니다」가 보입니다. 로그 `2-setup.log`를 보내 주세요.

## 2-1단계. 2단계가 끝나면 **바로** WSL 다시 시작(DNS 설정을 굳힘)

2단계가 `/etc/wsl.conf`에 `generateResolvConf = false`를 넣었습니다. 이 설정은 WSL을 다시 시작해야 적용됩니다.

- **2단계와 이 단계 사이에 다른 일을 하지 마세요.** 그 사이 새 WSL 터미널이 열리면(Orca 작업자 포함) WSL이 `/etc/resolv.conf`를 다시 링크로 만들 수 있습니다.
  - 그래도 복구 장치가 있습니다. 부팅 복구 서비스가 재시작 때 실제 파일로 되살리고, 2-2단계 재실행도 고칩니다.
- **`wsl --shutdown`은 이 터미널만 끄는 것이 아닙니다.** 모든 WSL 배포판, Orca 작업자, Runner, Docker Desktop의 WSL 쪽까지 함께 멈춥니다. 하던 작업을 먼저 저장하고 정리하세요.

```bash
/mnt/c/Windows/System32/wsl.exe --shutdown      # Windows PowerShell에서 wsl --shutdown 해도 같습니다
```

## 2-2단계. 다시 연 뒤 설치를 한 번 더 실행(상태 확정)

같은 설치 명령을 한 번 더 실행합니다. 이미 된 부분은 건너뜁니다. 재시작 틈에 링크가 다시 생겼어도 여기서 저장 사본으로 고칩니다.

```bash
bash agent-runner/scripts/isolation/setup-agent-user.sh 2>&1 | tee ~/awbs-setup-logs/2-setup-again.log; echo "exit=${PIPESTATUS[0]}"
```

확인합니다.

```bash
ls -l /etc/resolv.conf          # 맨 앞이 l(링크)이 아니라 -(실제 파일)이어야 합니다
head -n 3 /etc/resolv.conf      # 첫 줄 「# Agent WBS(Q-08): WSL DNS 터널링…」, 다음 줄 nameserver 10.255.255.254
getent hosts api.anthropic.com  # 주소가 한 줄 나오면 owner·Runner DNS 정상
```

- **DNS가 안 될 때:** 이 설정은 Windows 쪽 「DNS 터널링」에 기댑니다(주소 `10.255.255.254`). 나중에 `.wslconfig`의 `dnsTunneling=false`나 WSL 업데이트로 터널링이 꺼지면 이 주소가 응답하지 않습니다.
  - 그때 확인 스크립트가 「Runner 계정도 … 찾지 못함」 FAIL을 냅니다.
  - 할 일: 제거 스크립트로 되돌린 뒤(`remove-agent-user.sh`, 9단계) WSL을 다시 시작하고 설치를 다시 실행합니다. 그러면 설치가 그 상태에 맞는 방식(대체 방식 등)을 고릅니다.

## 3단계. Claude·Codex CLI 설치(관리자 권한 없음)

```bash
bash agent-runner/scripts/isolation/install-agent-cli.sh 2>&1 | tee ~/awbs-setup-logs/3-cli.log; echo "exit=${PIPESTATUS[0]}"
```

- **하는 일:** npm 공식 저장소에서 Claude Code·Codex의 **최신 버전**을 읽어 `/srv/agentwbs/cli/<claude|codex>/<버전>/`에 설치하고 `current` 링크를 겁니다. 설치한 프로그램이 그 버전을 말하는지만 확인합니다(돈 안 듦).
- **성공이면:** `current → 2.x.y`(claude), `current → 0.x.y`(codex), `exit=0`이 보입니다.
- **그 뒤 최신 유지:** Runner가 시작할 때와 매일 최신 버전을 확인하고, 일이 없을 때 바꿉니다. Runner를 오래 꺼 두었으면 Runner를 끈 채 이 명령을 다시 실행하면 최신으로 맞춰집니다.
- **실패하면:** `최신 버전을 읽지 못했습니다`(네트워크) 또는 `설치 실패`가 보입니다. 로그 `3-cli.log`를 보내 주세요.

## 4단계. Agent 계정으로 Claude·Codex 로그인(한 번, 직접 입력)

로그인은 화면과 주고받아야 해서 `tee`를 쓰지 않습니다. 돈이 드는 모델 호출은 없습니다.
브라우저가 자동으로 열리지 않습니다(Agent 계정은 Windows 프로그램을 못 띄우게 막았기 때문). 주소를 **직접 복사**해 Windows 브라우저에 붙여 넣습니다.

- 터미널에서 복사: 마우스로 드래그한 뒤 `Ctrl+Shift+C`(Windows Terminal). 붙여넣기: `Ctrl+Shift+V` 또는 마우스 오른쪽 클릭.

### 4-1. Claude

```bash
sudo -u awbs-agent -H -- env -C /home/awbs-agent PATH=/srv/agentwbs/runtime/node/bin:/usr/bin:/bin \
  /srv/agentwbs/cli/claude/current/bin/claude auth login
```

1. 화면에 로그인 주소(`https://claude.ai/...` 또는 `https://console.anthropic.com/...`로 시작)가 나옵니다. 그 주소를 복사해 Windows 브라우저에 붙여 넣습니다.
2. 브라우저에서 Agent가 쓸 Anthropic 계정으로 로그인하고 권한을 허락합니다.
3. 브라우저에 **코드**가 나오면 복사해서 터미널에 붙여 넣고 `Enter`를 누릅니다.
4. 터미널에 로그인 성공 문구가 나오고 명령이 끝나면 됩니다.

### 4-2. Codex

```bash
sudo -u awbs-agent -H -- env -C /home/awbs-agent PATH=/srv/agentwbs/runtime/node/bin:/usr/bin:/bin \
  /srv/agentwbs/cli/codex/current/bin/codex login --device-auth
```

1. 화면에 **주소**와 **일회용 코드**(예: `ABCD-1234`)가 나옵니다.
2. 주소를 Windows 브라우저에 붙여 넣고, Agent가 쓸 ChatGPT 계정으로 로그인한 뒤 코드를 입력합니다.
3. 터미널에 로그인 성공 문구가 나오고 명령이 끝나면 됩니다.
- 「기기 코드 로그인이 꺼져 있다」는 안내가 나오면, ChatGPT 웹의 보안 설정에서 기기 코드 로그인을 켠 뒤 다시 실행합니다.

### 4-3. 로그인 확인(돈 안 듦)

```bash
sudo -u awbs-agent -H -- env -C /home/awbs-agent PATH=/srv/agentwbs/runtime/node/bin:/usr/bin:/bin \
  /srv/agentwbs/cli/claude/current/bin/claude auth status --json
sudo -u awbs-agent -H -- env -C /home/awbs-agent PATH=/srv/agentwbs/runtime/node/bin:/usr/bin:/bin \
  /srv/agentwbs/cli/codex/current/bin/codex login status
```

- **성공이면:** Claude는 `"loggedIn": true`가 보이고, Codex는 로그인됨 문구와 함께 끝납니다.
- 로그인 정보는 `/home/awbs-agent/.claude`·`.codex`에 저장됩니다. keeproll 계정의 로그인과는 따로입니다.

## 5단계. Runner 설정(.env 한 줄)

```bash
touch agent-runner/.env && chmod 600 agent-runner/.env
sed -i 's/^AWBS_AGENT_USER=.*$/AWBS_AGENT_USER=awbs-agent/' agent-runner/.env
grep -qx 'AWBS_AGENT_USER=awbs-agent' agent-runner/.env || printf '%s\n' 'AWBS_AGENT_USER=awbs-agent' >> agent-runner/.env
grep '^AWBS_AGENT' agent-runner/.env
```

- **하는 일:** Runner가 CLI·작업 폴더·입력 사본을 `/srv/agentwbs`에 두고, 로그인 상태를 Agent 계정으로 확인하게 합니다.
- **성공이면:** 마지막 줄에 `AWBS_AGENT_USER=awbs-agent` 한 줄만 보입니다(`AWBS_AGENT_ROOT`·`AWBS_AGENT_EXEC` 줄이 있다면 지워도 됩니다).

## 6단계. 격리 확인

```bash
bash agent-runner/scripts/isolation/check-agent-user.sh 2>&1 | tee ~/awbs-setup-logs/6-check.log; echo "exit=${PIPESTATUS[0]}"
```

- **하는 일:** Agent 계정으로 직접 해 보며 막혔는지 봅니다. 예: Runner 홈·`~/.config/gh`·verum 폴더를 못 읽는지, Windows로 못 나가는지(`/mnt` 아래 모든 드라이브), Runner·Agent 양쪽이 DNS로 서버 이름을 찾는지, `/etc/resolv.conf`가 실제 파일이고 `/etc/wsl.conf`에 `generateResolvConf = false`가 있는지, sudo 정책이 래퍼 하나뿐인지, 예약 실행이 막혔는지, 로그인됐는지. 아무것도 고치지 않습니다.
- **성공이면:** 마지막에 `결과: FAIL 0개`, `exit=0`.
- **WARN은 실패가 아닙니다.** 흔한 WARN:
  - `/tmp에 Runner 계정 파일 중 누구나 읽을 수 있는 것이 …개`: 공용 임시 폴더 안내입니다.
  - `관리자 규칙(비밀번호 없음)`: keeproll이 비밀번호 없이 root가 될 수 있다는 안내입니다. 원하면 NOPASSWD를 빼세요.
- **실패하면:** `FAIL`로 시작하는 줄을 **그대로** 보내 주세요. 바로 아래 `진단:` 줄이 있으면 함께 보내 주세요. 특히 `허용 목록에 없는 sudo 규칙`·`해석하지 않는 sudo 출력 줄`은 이 PC의 sudo 출력 모양을 처음 보는 경우라 그 줄이 꼭 필요합니다.

## 7단계. Runner 시작

```bash
pnpm -C agent-runner start
```

- Runner가 CLI 최신 확인과 준비 점검을 합니다. 준비 점검의 Claude·Codex 로그인 항목이 `ok`이면 됩니다.
- 실행 계층은 연결됐습니다(isolation.md §12.2). Runner는 실행 직전마다 래퍼 점검과 사용자 scope 시험을 다시 하고, 통과할 때만 Agent 계정으로 세션을 띄웁니다.
  - 사용자 scope에는 linger가 필요합니다. 아래로 확인합니다. `Linger=yes`가 보이면 됩니다.

    ```bash
    loginctl show-user "$USER" -p Linger
    ```

  - 실패하면 Runner 로그에 `실제 Agent 실행 보류: …`가 한 번 보입니다. 그 줄을 보내 주세요.
- 참고: 시도 흐름(개발·QA·재작업·재검증 실행)은 **기본 꺼짐**입니다(CI 자동 실행과 같은 방식).
  - 켜려면 `agent-runner/.env`에 `AWBS_ATTEMPT_AUTO=1` 한 줄을 더하고 Runner를 다시 시작합니다.
  - 왜 기본 꺼짐인가: 켜면 실제 Claude·Codex 호출(유료)이 시작됩니다. M8 실호출 전까지는 owner가 정할 때만 켭니다.
  - `AWBS_GITHUB_REPO`도 있어야 합니다. 작업 폴더를 만들 로컬 저장소를 그 주소로 찾기 때문입니다. 없으면 설정 오류로 멈춥니다.
  - 켜기 전에 아래 「래퍼·CLI를 바꾼 뒤」를 한 번 실행해 설치된 래퍼를 새것으로 바꿔야 합니다(fix3: safe.directory).
  - 자세한 동작은 `src/jobs/README.md` 「작업 폴더 규칙」·「결과 수집」입니다.

---

## 래퍼·CLI를 바꾼 뒤(fix1: ci-run·진입점 규칙·pnpm / fix2: git-inspect·git-bundle·cli-version·agent-file·ci-run --home / fix3: safe.directory)

- fix3(2026-11-28): 래퍼의 Agent 계정 git(`git-inspect`·`git-bundle`)과 `ci-run`이 작업 폴더를 「dubious ownership(소유자가 다른 저장소)」으로 거부하던 문제를 고쳤습니다.
  - 왜 생겼나: 작업 폴더는 Runner 계정(keeproll)이 만들어 넘기므로 소유자가 Agent 계정과 다릅니다. git은 소유자가 다른 저장소를 기본으로 거부합니다.
  - 고친 방법: 래퍼가 부르는 git만, 그 한 폴더만 명령줄 설정(`-c safe.directory=<폴더>`)으로 허용합니다. 저장소 설정으로는 넓힐 수 없는 보호 설정입니다.
  - 같은 묶음에 QA 증거 파일 읽기(`evidence-read`)도 더했습니다.
  - 확인 스크립트(6-2)가 `safe.directory`는 Agent 계정 전역 설정에만 있고 Runner 계정 설정에는 없는지 봅니다. Runner 쪽에 있다고 나오면 `git config --global --unset-all safe.directory`로 지웁니다.
  - 이 고침이 설치되기 전에는 전용 계정으로 시도 흐름을 돌릴 수 없습니다(HEAD 확인·결과 bundle이 실패).

래퍼(`awbs-agent-exec`)를 고치면 설치본(`/usr/local/libexec/awbs-agent-exec`)은 저절로 바뀌지 않습니다. 아래를 순서대로 실행합니다.
sudoers 규칙 한 줄은 바뀌지 않습니다(래퍼 하나만 허용).

1. Runner를 끕니다(Runner 터미널에서 `Ctrl+C`).
2. 설치 스크립트를 다시 실행합니다(이미 된 부분은 건너뛰고 래퍼만 새로 설치·점검합니다. 비밀번호를 물을 수 있습니다).

   ```bash
   cd ~/orca/workspaces/agent-wbs/m8prep-exec   # 병합 뒤에는 agent-wbs 저장소의 맨 위 폴더
   bash agent-runner/scripts/isolation/setup-agent-user.sh 2>&1 | tee ~/awbs-setup-logs/fix1-setup.log; echo "exit=${PIPESTATUS[0]}"
   ```

3. ①·CI가 쓸 pnpm을 설치합니다(관리자 권한 없음). 새 CLI의 `--version` 확인은 2번에서 설치한 래퍼로 Agent 계정이 합니다(비밀번호 묻지 않음).

   ```bash
   bash agent-runner/scripts/isolation/install-agent-cli.sh 2>&1 | tee ~/awbs-setup-logs/fix1-cli.log; echo "exit=${PIPESTATUS[0]}"
   ```

4. 확인합니다. `cmp`가 아무것도 출력하지 않고 `same`이 보이면 설치본이 저장소와 같습니다.

   ```bash
   cmp agent-runner/scripts/isolation/awbs-agent-exec.sh /usr/local/libexec/awbs-agent-exec && echo same
   bash agent-runner/scripts/isolation/check-agent-user.sh 2>&1 | tee ~/awbs-setup-logs/fix1-check.log; echo "exit=${PIPESTATUS[0]}"
   ls -l /srv/agentwbs/cli/pnpm/current
   ```

- **성공이면:** 2·3단계 `exit=0`, `same`, 확인 스크립트 `결과: FAIL 0개`, pnpm `current → 버전`.
- **CI 자동 실행은 기본 꺼짐입니다**(조정자 결정 7). 켜려면 `agent-runner/.env`에 `AWBS_CI_AUTO=1` 한 줄을 더하고 Runner를 다시 시작합니다.
- **실패하면:** 그 단계의 로그 파일과 마지막 `exit=` 줄을 보내 주세요.

## 되돌리기

Runner를 먼저 끕니다. 미리 보기 → 실제 순서로 실행합니다.

```bash
bash agent-runner/scripts/isolation/remove-agent-user.sh --dry-run 2>&1 | tee ~/awbs-setup-logs/9-remove-dry-run.log; echo "exit=${PIPESTATUS[0]}"
bash agent-runner/scripts/isolation/remove-agent-user.sh 2>&1 | tee ~/awbs-setup-logs/9-remove.log; echo "exit=${PIPESTATUS[0]}"
```

- **하는 일:** 실행 규칙 회수 → Agent 프로세스 종료·확인 → 예약 작업 삭제 → 계정 삭제(로그인 정보 포함) → Windows 차단 해제 → 작업 영역의 Agent 권한 흔적 정리 → 기록 삭제.
- 작업 영역(`/srv/agentwbs`)까지 지우려면 `--purge-work`를 붙입니다.
- `.env`의 `AWBS_AGENT_USER` 줄도 지웁니다.
- **성공이면:** `exit=0`.
- **`exit=3`이면:** 「남은 항목」 목록이 보입니다. 다른 계정을 건드리지 않으려고 일부 단계를 건너뛴 것입니다. 그 목록을 보내 주세요.
- **다른 0 아닌 값이면:** 중간에 멈춘 것입니다. Windows 차단은 걸린 채로 남습니다. 로그를 보내 주세요.
