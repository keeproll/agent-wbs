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
  6. Agent 작업 영역 `/srv/agentwbs`(cli·inputs·worktrees)와 Agent용 node를 만듭니다.
  7. 실행 래퍼를 설치하고 Agent 계정으로 점검(`check`)합니다.
  8. 점검이 `ok`일 때만 마지막에 sudoers 규칙 한 줄을 넣습니다.
- **성공이면:** `래퍼 점검: ok`, `== 끝. 다음에 owner가 할 일`, `exit=0`이 보입니다.
- **실패하면:** 종료 코드가 0이 아니고, 「설치가 중간에 멈췄습니다 … 닫힌 상태로 둡니다」가 보입니다. 로그 `2-setup.log`를 보내 주세요.

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

- **하는 일:** Agent 계정으로 직접 해 보며 막혔는지 봅니다. 예: Runner 홈·`~/.config/gh`·verum 폴더를 못 읽는지, Windows로 못 나가는지, sudo 정책이 래퍼 하나뿐인지, 예약 실행이 막혔는지, 로그인됐는지. 아무것도 고치지 않습니다.
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
- 참고: 실제 Agent 세션 실행은 exec 계층(M5-02)이 연결된 뒤에 시작됩니다(isolation.md §12.2).

---

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
