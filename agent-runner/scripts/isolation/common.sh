# shellcheck shell=bash
# setup-agent-user.sh · remove-agent-user.sh · check-agent-user.sh가 함께 쓰는 값과 함수.
# 직접 실행하지 않는다. 다른 스크립트가 `source`로 읽는다.
# 아래 값들은 이 파일을 읽는 스크립트들이 쓴다(여기서 안 써도 경고하지 않게).
# shellcheck disable=SC2034

# 이 스크립트들은 bash 기능(pipefail, 배열, [[ ]])을 쓴다. sh(dash)로 부르면 여기서 멈춘다.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행하세요. 예: bash $0" >&2
  exit 2
fi

# ------------------------------------------------------------------ 고정값
# 계정 이름과 경로는 옵션으로 바꾸지 못한다.
# 왜: 옵션 오입력 하나로 root나 다른 계정을 잠그거나 지우거나, 다른 폴더를 지우면 안 된다(리뷰 P2-2·P2-3).
AGENT_USER=awbs-agent

# 시험 모드: 가짜 루트 폴더 아래에서만 움직인다. 실제 관리자 명령은 하나도 실행하지 않는다.
# 안전 장치: 시험 루트의 bin/sudo(가짜)가 PATH에서 먼저 잡혀야만 켜진다. 아니면 바로 멈춘다.
ROOT_PREFIX=''
if [[ -n ${AWBS_ISOLATION_TEST_ROOT:-} ]]; then
  ROOT_PREFIX=$AWBS_ISOLATION_TEST_ROOT
  if [[ $ROOT_PREFIX != /* || ! -x $ROOT_PREFIX/bin/sudo || $(command -v sudo) != "$ROOT_PREFIX/bin/sudo" ]]; then
    echo '시험 모드는 시험 루트의 가짜 sudo가 PATH 맨 앞에 있을 때만 씁니다.' >&2
    exit 2
  fi
fi

AGENT_HOME=$ROOT_PREFIX/home/$AGENT_USER
AGENT_ROOT=$ROOT_PREFIX/srv/agentwbs
EXEC_PATH=$ROOT_PREFIX/usr/local/libexec/awbs-agent-exec
CONF_DIR=$ROOT_PREFIX/etc/agentwbs
CONF_PATH=$CONF_DIR/agent-exec.conf
# 설치가 만든 Agent 계정의 숫자 번호(UID) 기록. 재설치 때 「우리가 만든 계정」인지, 제거 때 숫자 권한 항목을 지우는 데 쓴다.
UID_RECORD=$CONF_DIR/agent-user.uid
SUDOERS_PATH=$ROOT_PREFIX/etc/sudoers.d/awbs-agent
GUARD_UNIT=awbs-agent-wsl-guard.service
GUARD_PATH=$ROOT_PREFIX/etc/systemd/system/$GUARD_UNIT
WSL_BLOCK_DIRS=("$ROOT_PREFIX/mnt" "$ROOT_PREFIX/Docker" "$ROOT_PREFIX/run/WSL")
WSL_INTEROP=$ROOT_PREFIX/proc/sys/fs/binfmt_misc/WSLInterop
# 설치·제거·확인 스크립트가 실제 sudo 정책에서 기대하는 실행 래퍼 경로(시험 모드에서도 실제 경로 문자열)
REAL_EXEC_PATH=/usr/local/libexec/awbs-agent-exec
DRY_RUN=0

# ------------------------------------------------------------------ 출력
step() { printf '\n== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }
die() { printf '오류: %s\n' "$1" >&2; exit "${2:-1}"; }

# ------------------------------------------------------------------ 실행
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
# Agent가 바꿀 수 있는 곳(Agent 홈 등)은 root가 아니라 Agent 권한으로 다룬다(리뷰 P1-1).
as_agent() {
  if ((DRY_RUN)); then
    printf '[dry-run] sudo -u %q -H --' "$AGENT_USER"
    printf ' %q' "$@"
    printf '\n'
  else
    sudo -u "$AGENT_USER" -H -- "$@"
  fi
}

# root 소유 폴더가 없을 때만 만든다. 이미 있는 시스템 폴더(/etc/sudoers.d 등)의 권한은 바꾸지 않는다.
ensure_root_dir() {
  if [[ -d $1 && ! -L $1 ]]; then return 0; fi
  as_root install -d -o root -g root -m 0755 "$1"
}

# ------------------------------------------------------------------ 검사
# 이름 검사: 리눅스 계정 이름 규칙(소문자로 시작, 32자 이하).
valid_user() { [[ $1 =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }

# 경로 검사: 정규화된 절대 경로(`..`·`//`·끝 `/` 없음, 공백·따옴표 없음).
valid_path() { [[ $1 =~ ^/[A-Za-z0-9._/-]+$ && $1 != *..* && $1 != *//* && $1 != */ ]]; }

# 파일·폴더의 소유자 이름. 시험 모드에서는 가짜 루트의 `.owners`(줄마다 「경로 소유자」)를 보고, 없으면 root로 본다.
owner_of() {
  if [[ -n $ROOT_PREFIX ]]; then
    local rel=${1#"$ROOT_PREFIX"} path owner
    if [[ -f $ROOT_PREFIX/.owners ]]; then
      while read -r path owner; do
        [[ $path == "$rel" ]] && { printf '%s' "$owner"; return; }
      done < "$ROOT_PREFIX/.owners"
    fi
    printf root
  else
    stat -c %U -- "$1"
  fi
}

# root가 다룰 고정 경로 하나를 검사한다.
# 쓰기: safe_fixed_path <경로> [root 말고 더 허용할 소유자...]
# - 경로의 모든 단계가 링크가 아니어야 한다.
# - 이미 있는 단계는 소유자가 root이거나 더 허용한 계정이어야 한다. Agent 계정은 절대 허용하지 않는다.
# 왜: root 명령이 Agent가 바꿀 수 있는 링크를 따라가면 링크가 가리키는 시스템 폴더를 바꾼다(리뷰 P1-1).
#   그래서 대상은 고정 절대 경로만 쓰고, 경로 중간에 링크나 예상 밖 소유자가 있으면 아예 거부한다.
safe_fixed_path() {
  local path=$1 part='' owner seg
  shift
  local allowed=" root $* "
  valid_path "$path" || die "고정 경로 형식이 아닙니다: $path"
  local rest=${path#"$ROOT_PREFIX"}
  part=$ROOT_PREFIX
  local -a segs
  IFS=/ read -r -a segs <<< "${rest#/}"
  for seg in "${segs[@]}"; do
    part=$part/$seg
    [[ -L $part ]] && die "링크는 따라가지 않습니다: $part"
    [[ -e $part ]] || return 0
    owner=$(owner_of "$part")
    [[ $owner != "$AGENT_USER" && $allowed == *" $owner "* ]] || die "예상 밖 소유자($owner)입니다: $part"
  done
}

# 이미 있는 Agent 계정이 이 설치가 만든 전용 계정인지 본다. 결과: none(없음) · ours(우리 계정) · foreign(다른 계정)
# ours의 조건: 설치 기록의 UID와 같음, 시스템 계정 번호(1~999), 홈 /home/awbs-agent, 셸 nologin,
#              기본 그룹 awbs-agent, 다른 그룹에는 속하지 않음.
# 왜: 같은 이름의 다른 계정을 고치거나 지우면 안 된다(리뷰 P2-2).
agent_account_state() {
  local entry uid gid home shell group extra recorded=''
  if ! entry=$(getent passwd "$AGENT_USER"); then
    echo none
    return
  fi
  IFS=: read -r _ _ uid gid _ home shell <<< "$entry"
  group=$(getent group "$gid" | cut -d: -f1 || true)
  extra=$(getent group | awk -F: -v u="$AGENT_USER" '$4 ~ "(^|,)" u "(,|$)" { print $1 }' || true)
  [[ -f $UID_RECORD ]] && recorded=$(< "$UID_RECORD")
  if [[ $uid =~ ^[0-9]+$ ]] && ((uid > 0 && uid < 1000)) && [[ $recorded == "$uid" && $home == "/home/$AGENT_USER" \
    && $shell == /usr/sbin/nologin && $group == "$AGENT_USER" && -z $extra ]]; then
    echo ours
  else
    echo foreign
  fi
}
