#!/usr/bin/env bash
# Agent 전용 OS 계정 설치(Q-08). owner가 Runner 계정(keeproll)으로 한 번 실행한다.
#
#   bash agent-runner/scripts/isolation/setup-agent-user.sh --dry-run   # 무엇을 할지 보기만(sudo 안 씀)
#   bash agent-runner/scripts/isolation/setup-agent-user.sh             # 실제 설치(중간에 sudo 비밀번호를 물음)
#
# 옵션
#   --dry-run             관리자 명령을 실행하지 않고 보여 주기만 한다. 만들 파일 내용도 보여 준다.
#   --agent-user 이름      Agent 계정 이름(기본 awbs-agent)
#   --agent-root 경로      Agent 작업 영역(기본 /srv/agentwbs)
#   --node 경로            Agent가 쓸 node 실행 파일(기본: 지금 PATH의 node)
#
# 이 스크립트 자신은 sudo로 부르지 않는다. 관리자 권한이 필요한 줄만 안에서 sudo로 실행한다.
# 왜: Runner 계정 이름·홈·node 위치를 「지금 사용자」에게서 읽어야 하기 때문이다(sudo 안에서는 root가 된다).
# 다시 실행해도 된다. 이미 있는 계정·폴더는 그대로 두고 권한·파일만 다시 맞춘다.
# bash 전용이다. sh(dash)로 부르면 pipefail에서 알 수 없는 오류가 나므로 여기서 먼저 멈춘다.
if [ -z "${BASH_VERSION:-}" ]; then echo "bash로 실행하세요. 예: bash $0" >&2; exit 2; fi
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$HERE/common.sh"

NODE_BIN=''
while (($#)); do
  case $1 in
    --dry-run) DRY_RUN=1; shift ;;
    --agent-user) AGENT_USER=${2-}; shift 2 ;;
    --agent-root) AGENT_ROOT=${2-}; shift 2 ;;
    --node) NODE_BIN=${2-}; shift 2 ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "모르는 옵션입니다: $1" 2 ;;
  esac
done

# ---------------------------------------------------------------- 0. 사전 확인(관리자 권한 없음)
step '0. 사전 확인(관리자 권한 필요 없음)'
RUNNER_USER=$(id -un)
RUNNER_HOME=$HOME
# Runner 계정으로 실행해야 한다. root로 실행하면 Runner 계정 이름을 root로 잘못 적는다.
[[ $(id -u) != 0 ]] || die 'root가 아니라 Runner 계정(예: keeproll)으로 실행하세요. sudo bash ... 로 부르지 마세요.'
valid_user "$AGENT_USER" || die "Agent 계정 이름이 올바르지 않습니다: $AGENT_USER"
valid_user "$RUNNER_USER" || die "Runner 계정 이름이 올바르지 않습니다: $RUNNER_USER"
[[ $AGENT_USER != "$RUNNER_USER" ]] || die 'Agent 계정과 Runner 계정은 달라야 합니다.'
valid_path "$AGENT_ROOT" || die "작업 영역 경로가 올바르지 않습니다: $AGENT_ROOT"
valid_path "$RUNNER_HOME" || die "Runner 홈 경로가 올바르지 않습니다: $RUNNER_HOME"
# 작업 영역을 Runner 홈 안에 두면 Agent가 Runner 홈에 들어가야 하므로 막는다.
[[ $AGENT_ROOT != "$RUNNER_HOME" && $AGENT_ROOT != "$RUNNER_HOME"/* ]] || die '작업 영역은 Runner 홈 밖이어야 합니다.'
[[ -n $NODE_BIN ]] || NODE_BIN=$(command -v node || true)
[[ -n $NODE_BIN ]] || die 'node를 찾지 못했습니다. --node 경로를 주세요.'
NODE_BIN=$(realpath -e -- "$NODE_BIN") || die "node 파일이 없습니다: $NODE_BIN"
[[ -x $NODE_BIN ]] || die "node가 실행 파일이 아닙니다: $NODE_BIN"
command -v sudo > /dev/null || die 'sudo가 없습니다.'
[[ -f $HERE/awbs-agent-exec.sh ]] || die '실행 래퍼(awbs-agent-exec.sh)가 같은 폴더에 없습니다.'
IS_WSL=0
[[ -e /proc/sys/fs/binfmt_misc/WSLInterop || -d /run/WSL ]] && IS_WSL=1
AGENT_HOME=/home/$AGENT_USER
note "Runner 계정: $RUNNER_USER (홈 $RUNNER_HOME)"
note "Agent 계정: $AGENT_USER (홈 $AGENT_HOME)"
note "Agent 작업 영역: $AGENT_ROOT"
note "Agent용 node: $NODE_BIN ($("$NODE_BIN" --version))"
note "WSL 여부: $([[ $IS_WSL == 1 ]] && echo 예 || echo 아니오)"
((DRY_RUN)) && note 'dry-run: 아래 sudo 명령은 실행하지 않고 보여 주기만 합니다.'

# 설치할 파일 내용은 먼저 Runner 계정의 임시 폴더에 만들고, 확인한 뒤 root 소유로 옮긴다.
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

cat > "$TMP/agent-exec.conf" << EOF
# Agent WBS 실행 래퍼 설정(setup-agent-user.sh가 만듦). 래퍼는 이 이름들만 읽는다.
AGENT_USER=$AGENT_USER
RUNNER_USER=$RUNNER_USER
RUNNER_HOME=$RUNNER_HOME
AGENT_ROOT=$AGENT_ROOT
NODE_DIR=$AGENT_ROOT/runtime/node/bin
EOF

cat > "$TMP/sudoers" << EOF
# Agent WBS(Q-08): Runner 계정($RUNNER_USER)은 실행 래퍼 하나만 Agent 계정($AGENT_USER)으로 비밀번호 없이 실행한다.
# root로 실행하는 권한은 주지 않는다. 래퍼가 실행할 CLI·작업 폴더를 검사한다.
Cmnd_Alias AWBS_AGENT_EXEC = $EXEC_PATH
Defaults!AWBS_AGENT_EXEC env_reset, !setenv
$RUNNER_USER ALL=($AGENT_USER) NOPASSWD: AWBS_AGENT_EXEC
EOF

cat > "$TMP/guard.service" << EOF
# Agent WBS(Q-08): 부팅마다 Agent 계정이 WSL의 Windows 실행 통로(/run/WSL)에 들어가지 못하게 막는다.
# /run은 부팅 때마다 새로 만들어지므로 권한 설정도 부팅마다 다시 해야 한다.
[Unit]
Description=Agent WBS: block $AGENT_USER from WSL interop sockets
After=local-fs.target
ConditionPathExists=/run/WSL

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/setfacl -m u:$AGENT_USER:--- /run/WSL

[Install]
WantedBy=multi-user.target
EOF

# sudoers 문법을 미리 검사한다. 문법이 틀린 파일을 넣으면 sudo 전체가 멈출 수 있기 때문이다.
if /usr/sbin/visudo -c -q -f "$TMP/sudoers" > /dev/null 2>&1; then
  note 'sudoers 문법 검사(미리 보기): 통과'
else
  note 'sudoers 문법 검사(미리 보기): 관리자 권한 없이는 확인하지 못함. 5단계에서 sudo로 다시 검사한다.'
fi

if ((DRY_RUN)); then
  for f in agent-exec.conf sudoers guard.service; do
    printf '\n--- 만들 파일: %s\n' "$f"
    cat "$TMP/$f"
  done
fi

# ---------------------------------------------------------------- 1. 필요한 도구
step '1. 권한 목록(ACL) 도구 설치'
note 'ACL = 소유자·그룹 말고도 「이 계정에는 이 권한」을 따로 적는 기능. setfacl 명령이 필요하다.'
if ! command -v setfacl > /dev/null; then
  as_root apt-get install -y acl                                       # setfacl·getfacl이 든 acl 패키지 설치
else
  note '이미 설치됨'
fi

# ---------------------------------------------------------------- 2. Agent 계정
step "2. Agent 전용 계정 $AGENT_USER 만들기"
if getent passwd "$AGENT_USER" > /dev/null; then
  note '이미 있음(새로 만들지 않음)'
else
  # --system: 사람용이 아닌 시스템 계정. --shell nologin: 로그인 셸로 들어올 수 없음. --user-group: 같은 이름의 전용 그룹.
  as_root useradd --system --user-group --create-home --home-dir "$AGENT_HOME" \
    --shell /usr/sbin/nologin --comment 'Agent WBS agent' "$AGENT_USER"
fi
as_root passwd --lock "$AGENT_USER"                                      # 비밀번호 로그인을 잠금(비밀번호로 들어올 수 없음)
as_root chmod 0700 "$AGENT_HOME"                                         # Agent 홈(Claude·Codex 로그인 정보)은 Agent만 읽음
as_root install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "$AGENT_HOME/tmp"   # Agent 전용 임시 폴더(TMPDIR)
# Agent 계정의 git 설정: 작업 폴더는 Runner가 만들어 소유자가 다르므로, git이 「소유자가 다른 저장소」라고 멈추지 않게 한다.
# git 2.43은 경로 접두어(/*)를 지원하지 않아 '*'를 쓴다. 이 설정은 Agent 계정 자신에게만 적용된다.
as_agent git -C / config --global --replace-all safe.directory '*'

# ---------------------------------------------------------------- 3. 작업 영역
step "3. Agent 작업 영역 $AGENT_ROOT"
note '소유자 Runner, 그룹 Agent. Agent는 cli·inputs를 읽기만, worktrees 안에서만 쓴다.'
as_root install -d -o "$RUNNER_USER" -g "$AGENT_USER" -m 0750 "$AGENT_ROOT"            # 영역 자체: Runner 쓰기, Agent 들어가기만
as_root install -d -o "$RUNNER_USER" -g "$AGENT_USER" -m 2750 "$AGENT_ROOT/cli"        # Runner가 설치한 CLI: Agent는 읽기·실행만
as_root install -d -o "$RUNNER_USER" -g "$AGENT_USER" -m 2750 "$AGENT_ROOT/inputs"     # 입력 자료 사본: Agent는 읽기만
as_root install -d -o "$RUNNER_USER" -g "$AGENT_USER" -m 2750 "$AGENT_ROOT/worktrees"  # 작업 폴더 모음: 맨 위는 Agent가 못 바꿈
# 2750의 앞자리 2(setgid): 안에 새로 만드는 파일·폴더도 그룹이 Agent 그룹이 된다.
# 기본 ACL: worktrees 아래 새 폴더·파일에 Runner·Agent 둘 다 읽기·쓰기 권한이 자동으로 붙는다(umask와 무관).
as_root setfacl -m "d:u:$RUNNER_USER:rwx,d:u:$AGENT_USER:rwx,d:g::r-x,d:m::rwx,d:o::---" "$AGENT_ROOT/worktrees"
as_root install -d -o root -g root -m 0755 "$AGENT_ROOT/runtime" "$AGENT_ROOT/runtime/node" "$AGENT_ROOT/runtime/node/bin"
as_root install -o root -g root -m 0755 "$NODE_BIN" "$AGENT_ROOT/runtime/node/bin/node"   # Agent용 node(Runner의 nvm은 Runner 홈 안이라 못 씀)

# ---------------------------------------------------------------- 4. 실행 래퍼와 설정
step '4. 실행 래퍼와 설정 파일'
as_root install -d -o root -g root -m 0755 "$(dirname "$EXEC_PATH")" "$CONF_DIR"
as_root install -o root -g root -m 0755 "$HERE/awbs-agent-exec.sh" "$EXEC_PATH"         # root 소유: Runner·Agent 누구도 못 고침
as_root install -o root -g root -m 0644 "$TMP/agent-exec.conf" "$CONF_PATH"             # 래퍼 설정(비밀값 없음)

# ---------------------------------------------------------------- 5. sudoers
step '5. sudoers 규칙(래퍼 하나만, Agent 계정으로만, 비밀번호 없이)'
as_root /usr/sbin/visudo -c -q -f "$TMP/sudoers"                         # 문법 검사. 틀리면 여기서 멈춘다
as_root install -o root -g root -m 0440 "$TMP/sudoers" "$SUDOERS_PATH"   # sudoers 파일은 0440이어야 sudo가 읽는다

# ---------------------------------------------------------------- 6. WSL 보호
step '6. WSL 보호(Windows 드라이브·Windows 프로그램 실행 통로 막기)'
if ((IS_WSL)); then
  note 'WSL에서는 /mnt/c 같은 Windows 드라이브를 누구나 읽고 쓸 수 있고, Windows 프로그램(.exe)을 실행하면 Windows 사용자 권한으로 돈다.'
  note '그래서 Agent 계정만 /mnt·/run/WSL에 들어가지 못하게 막는다. Runner 계정(keeproll)은 그대로 쓸 수 있다.'
  as_root setfacl -m "u:$AGENT_USER:---" /mnt                            # Windows 드라이브(/mnt/c 등) 막기(디스크에 남음)
  [[ -d /Docker ]] && as_root setfacl -m "u:$AGENT_USER:---" /Docker     # Docker Desktop이 붙인 Windows 폴더 막기
  [[ -d /run/WSL ]] && as_root setfacl -m "u:$AGENT_USER:---" /run/WSL   # 지금 부팅의 Windows 실행 통로 막기
  as_root install -o root -g root -m 0644 "$TMP/guard.service" "$GUARD_PATH"   # 다음 부팅부터도 막는 서비스
  as_root systemctl daemon-reload                                        # 새 서비스 파일 읽기
  as_root systemctl enable "$GUARD_UNIT"                                 # 부팅 때 자동 실행
else
  note 'WSL이 아니라 건너뜀'
fi

# ---------------------------------------------------------------- 끝
step '끝. 다음에 owner가 할 일'
cat << EOF
   1) Agent 계정으로 Claude·Codex에 한 번 로그인합니다(문서 isolation.md 「로그인」 절).
   2) Runner 환경 파일(agent-runner/.env)에 아래 세 줄을 넣습니다.
        AWBS_AGENT_USER=$AGENT_USER
        AWBS_AGENT_ROOT=$AGENT_ROOT
        AWBS_AGENT_EXEC=$EXEC_PATH
   3) 확인 스크립트를 돌립니다: bash $HERE/check-agent-user.sh
EOF
((DRY_RUN)) && printf '\n(dry-run이라 아무것도 바꾸지 않았습니다.)\n'
exit 0
