# shellcheck shell=bash
# 아래 값들은 이 파일을 읽는 스크립트들이 쓴다(여기서 안 써도 경고하지 않게).
# shellcheck disable=SC2034
# setup-agent-user.sh · remove-agent-user.sh · check-agent-user.sh가 함께 쓰는 값과 함수.
# 직접 실행하지 않는다. 다른 스크립트가 `source`로 읽는다.

# 이 스크립트들은 bash 기능(pipefail, 배열, [[ ]])을 쓴다. sh(dash)로 부르면 여기서 멈춘다.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행하세요. 예: bash $0" >&2
  exit 2
fi

# 기본값. 바꾸려면 각 스크립트의 옵션을 쓴다. 세 스크립트와 Runner 설정(AWBS_AGENT_*)이 같은 값을 써야 한다.
AGENT_USER=awbs-agent
AGENT_ROOT=/srv/agentwbs
EXEC_PATH=/usr/local/libexec/awbs-agent-exec
CONF_DIR=/etc/agentwbs
CONF_PATH=$CONF_DIR/agent-exec.conf
SUDOERS_PATH=/etc/sudoers.d/awbs-agent
GUARD_UNIT=awbs-agent-wsl-guard.service
GUARD_PATH=/etc/systemd/system/$GUARD_UNIT
DRY_RUN=0

# 관리자 권한이 필요한 명령 하나를 실행한다. dry-run이면 실행하지 않고 그대로 보여 준다.
as_root() {
  if ((DRY_RUN)); then
    printf '[dry-run] sudo'
    printf ' %q' "$@"
    printf '\n'
  else
    sudo -- "$@"
  fi
}

# Agent 계정으로 명령 하나를 실행한다(owner의 sudo 권한 사용). dry-run이면 보여 주기만 한다.
as_agent() {
  if ((DRY_RUN)); then
    printf '[dry-run] sudo -u %q -H --' "$AGENT_USER"
    printf ' %q' "$@"
    printf '\n'
  else
    sudo -u "$AGENT_USER" -H -- "$@"
  fi
}

# 단계 제목을 보여 준다.
step() { printf '\n== %s\n' "$1"; }

# 사람이 읽을 설명을 보여 준다.
note() { printf '   %s\n' "$1"; }

die() { printf '오류: %s\n' "$1" >&2; exit "${2:-1}"; }

# 이름 검사: 리눅스 계정 이름 규칙(소문자로 시작, 32자 이하).
valid_user() { [[ $1 =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }

# 경로 검사: 절대 경로, 공백·따옴표·`..` 없음.
valid_path() { [[ $1 =~ ^/[A-Za-z0-9._/-]+$ && $1 != *..* ]]; }
