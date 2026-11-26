#!/usr/bin/env bash
# 설치 후 확인: Agent 전용 계정이 정말 격리됐는지 본다(Q-08). owner가 Runner 계정으로 실행한다.
#
#   bash agent-runner/scripts/isolation/check-agent-user.sh
#   bash agent-runner/scripts/isolation/check-agent-user.sh --protect /home/keeproll/projects/verum-sdn
#
# 옵션
#   --protect 경로      Agent가 읽으면 안 되는 폴더를 더 추가한다(여러 번 쓸 수 있음).
#   --agent-user 이름   Agent 계정 이름(기본 awbs-agent)
#   --agent-root 경로   Agent 작업 영역(기본 /srv/agentwbs)
#
# 「Agent 계정으로 해 보기」 확인은 owner의 sudo 권한을 쓴다(비밀번호를 물을 수 있음). 아무것도 고치지 않는다.
# 결과: 줄마다 PASS·FAIL·WARN. FAIL이 하나라도 있으면 종료 코드 1.
# bash 전용이다. sh(dash)로 부르면 pipefail에서 알 수 없는 오류가 나므로 여기서 먼저 멈춘다.
if [ -z "${BASH_VERSION:-}" ]; then echo "bash로 실행하세요. 예: bash $0" >&2; exit 2; fi
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$HERE/common.sh"

PROTECT=()
while (($#)); do
  case $1 in
    --protect) PROTECT+=("${2-}"); shift 2 ;;
    --agent-user) AGENT_USER=${2-}; shift 2 ;;
    --agent-root) AGENT_ROOT=${2-}; shift 2 ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "모르는 옵션입니다: $1" 2 ;;
  esac
done
[[ $(id -u) != 0 ]] || die 'root가 아니라 Runner 계정으로 실행하세요.'
valid_user "$AGENT_USER" || die "Agent 계정 이름이 올바르지 않습니다: $AGENT_USER"

FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
warn() { printf 'WARN  %s\n' "$1"; }
# must_pass 「통과 문구」 「실패 문구」 명령...: 명령이 성공해야 PASS.
must_pass() { local ok=$1 no=$2; shift 2; if "$@"; then pass "$ok"; else fail "$no"; fi; }
# must_fail 「통과 문구」 「실패 문구」 명령...: 명령이 실패해야(=막혀야) PASS.
must_fail() { local ok=$1 no=$2; shift 2; if "$@"; then fail "$no"; else pass "$ok"; fi; }
# Agent 계정으로 명령을 해 본다. 명령의 출력은 버리고 성공/실패만 본다.
agent_can() { sudo -u "$AGENT_USER" -H -- env -C / "$@" > /dev/null 2>&1; }

step '1. 계정'
if ! getent passwd "$AGENT_USER" > /dev/null; then
  fail "Agent 계정 $AGENT_USER가 없습니다. setup-agent-user.sh를 먼저 실행하세요."
  exit 1
fi
pass "계정 $AGENT_USER 있음"
shell=$(getent passwd "$AGENT_USER" | cut -d: -f7)
if [[ $shell == */nologin || $shell == */false ]]; then pass "로그인 셸 없음($shell)"; else fail "로그인 셸이 열려 있음($shell)"; fi
groups=" $(id -nG "$AGENT_USER") "
for g in sudo admin adm wheel docker "$(id -gn)"; do
  if [[ $groups == *" $g "* ]]; then fail "Agent 계정이 $g 그룹에 있음"; else pass "Agent 계정이 $g 그룹에 없음"; fi
done
# Runner 그룹에 Agent가 없어야 Runner 홈(0750)에 못 들어간다.

step '2. 비밀번호 없는 실행 권한(Runner → Agent, 래퍼 하나만)'
if out=$(sudo -n -u "$AGENT_USER" -- "$EXEC_PATH" check 2>&1); then
  pass "Runner가 비밀번호 없이 래퍼를 Agent 계정으로 실행: $out"
else
  fail "래퍼 실행 또는 래퍼 점검 실패: $(printf '%s' "$out" | tr '\n' ' ')"
fi
# 래퍼가 아닌 명령은 비밀번호 없이 실행되면 안 된다(규칙이 넓게 열렸는지 확인).
sudo -k
must_fail '래퍼가 아닌 명령은 비밀번호 없이 실행 안 됨' '래퍼가 아닌 명령(/bin/true)도 비밀번호 없이 Agent로 실행됨' \
  sudo -n -u "$AGENT_USER" -- /bin/true
must_fail '래퍼를 root로 비밀번호 없이 실행 못 함' '래퍼를 root로도 비밀번호 없이 실행할 수 있음' \
  sudo -n -u root -- "$EXEC_PATH" check

step '3. Agent 계정이 못 읽어야 하는 곳(이 단계부터 owner의 sudo 비밀번호를 물을 수 있음)'
targets=("$HOME" "$HOME/.agentwbs" "$HOME/.config/gh" "$HOME/.ssh" "$HOME/.orca" "$HOME/.claude" "$HOME/.codex")
for d in "$HOME"/projects/verum-* "$HOME"/.config/verum-* "${PROTECT[@]}"; do
  [[ -e $d ]] && targets+=("$d")
done
for t in "${targets[@]}"; do
  if agent_can test -r "$t" || agent_can test -x "$t" || agent_can ls -- "$t"; then
    fail "Agent가 읽거나 들어갈 수 있음: $t"
  else
    pass "Agent가 못 읽음: $t"
  fi
done
# 파일 하나를 직접 읽어 본다(폴더 권한이 맞아도 실제로 막히는지).
for f in "$HOME/.config/gh/hosts.yml" "$HOME/.agentwbs/runner.env" "$HOME/.bashrc"; do
  [[ -e $f ]] || continue
  must_fail "Agent가 파일을 못 읽음: $f" "Agent가 파일을 읽음: $f" agent_can cat -- "$f"
done

step '4. WSL 탈출 통로'
for t in /mnt /mnt/c /run/WSL /Docker/host; do
  [[ -e $t ]] || continue
  must_fail "Agent가 못 들어감: $t" "Agent가 들어갈 수 있음: $t" agent_can ls -- "$t"
done
if [[ -e /proc/sys/fs/binfmt_misc/WSLInterop && -f /mnt/c/Windows/System32/whoami.exe ]]; then
  # 진짜 Windows 프로그램(whoami.exe)을 Agent가 읽을 수 있는 곳에 복사해 Agent로 실행해 본다.
  # 실행되면 Agent가 Windows 사용자 권한으로 탈출할 수 있다는 뜻이다.
  probe=$(mktemp -d "$AGENT_ROOT/worktrees/.interop-XXXXXX")
  cp /mnt/c/Windows/System32/whoami.exe "$probe/" && chmod 0755 "$probe/whoami.exe"
  if ! "$probe/whoami.exe" > /dev/null 2>&1; then
    warn 'Runner 계정에서도 Windows 프로그램이 안 돌아 이 확인은 판정할 수 없음'
  elif agent_can "$probe/whoami.exe"; then
    fail 'Agent가 Windows 실행 통로로 Windows 프로그램을 띄울 수 있음'
  else
    pass 'Agent가 Windows 실행 통로를 못 씀(Runner 계정에서는 같은 프로그램이 돎)'
  fi
  rm -rf -- "$probe"
fi
must_fail 'Agent가 Docker 소켓을 못 씀' 'Agent가 Docker에 명령할 수 있음(root와 같은 권한)' agent_can test -w /var/run/docker.sock

step '5. 작업 영역 권한'
must_pass 'Agent가 CLI 폴더에 들어감' 'Agent가 CLI 폴더에 못 들어감' agent_can test -x "$AGENT_ROOT/cli"
must_fail 'Agent가 CLI 설치본을 못 고침' 'Agent가 CLI 설치본을 고칠 수 있음' agent_can test -w "$AGENT_ROOT/cli"
must_fail 'Agent가 입력 자료 폴더에 못 씀' 'Agent가 입력 자료 폴더에 쓸 수 있음' agent_can test -w "$AGENT_ROOT/inputs"
must_fail 'Agent가 작업 폴더 모음 맨 위는 못 바꿈' 'Agent가 작업 폴더 모음 맨 위를 바꿀 수 있음' agent_can test -w "$AGENT_ROOT/worktrees"
# Runner처럼 작업 폴더 하나를 만들고, Agent가 그 안에 쓰고, Runner가 다시 지울 수 있는지 본다.
probe_dir=$(mktemp -d "$AGENT_ROOT/worktrees/.check-XXXXXX" 2> /dev/null || true)
if [[ -n $probe_dir ]]; then
  if agent_can bash -c "mkdir '$probe_dir/sub' && echo x > '$probe_dir/sub/file'"; then
    pass 'Agent가 Runner가 만든 작업 폴더 안에 씀'
  else
    fail 'Agent가 작업 폴더 안에 못 씀'
  fi
  must_pass 'Runner가 Agent가 만든 파일을 지움' 'Runner가 Agent가 만든 파일을 못 지움' rm -rf -- "$probe_dir"
else
  fail "Runner가 $AGENT_ROOT/worktrees 안에 폴더를 못 만듦"
fi

step '6. 로그인 상태(돈이 들지 않는 상태 확인만)'
for agent in claude codex; do
  bin=$(compgen -G "$AGENT_ROOT/cli/$agent/current/bin/$agent" | head -n 1 || true)
  if [[ -z $bin ]]; then
    warn "$agent: Runner 설치본이 아직 없음($AGENT_ROOT/cli/$agent/current). Runner가 CLI를 설치한 뒤 다시 확인"
    continue
  fi
  run=(sudo -u "$AGENT_USER" -H -- env -i HOME="/home/$AGENT_USER" PATH="$AGENT_ROOT/runtime/node/bin:/usr/bin:/bin" "$bin")
  if [[ $agent == claude ]]; then
    # Claude는 로그인 안 돼도 0으로 끝날 수 있어 JSON의 loggedIn 값을 본다.
    "${run[@]}" auth status --json 2> /dev/null | grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true' && ok=1 || ok=0
  else
    "${run[@]}" login status > /dev/null 2>&1 && ok=1 || ok=0
  fi
  if ((ok)); then
    pass "$agent: Agent 계정 로그인됨"
  else
    warn "$agent: Agent 계정 로그인 안 됨. isolation.md 「로그인」 절대로 한 번 로그인"
  fi
done

step '7. 참고(경고만)'
# /tmp는 모든 계정이 같이 쓴다. Runner 계정 파일 중 누구나 읽을 수 있는 것이 있으면 알린다.
count=$(find /tmp -maxdepth 2 -user "$(id -un)" -perm -o=r 2> /dev/null | wc -l)
if ((count == 0)); then pass '/tmp에 Runner 계정의 공개 파일 없음'; else warn "/tmp에 Runner 계정 파일 중 누구나 읽을 수 있는 것이 ${count}개 있음(Agent도 읽을 수 있음)"; fi

printf '\n결과: FAIL %d개\n' "$FAILS"
((FAILS == 0))
