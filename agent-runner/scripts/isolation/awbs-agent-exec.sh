#!/usr/bin/env bash
# awbs-agent-exec — Agent 전용 OS 계정(awbs-agent)으로만 실행되는 실행 래퍼(Q-08).
#
# 설치 위치: /usr/local/libexec/awbs-agent-exec (root 소유, 0755). setup-agent-user.sh가 설치한다.
# Runner(keeproll)는 sudoers 규칙 한 줄로 이 파일만 awbs-agent 계정으로 실행할 수 있다.
#   sudo -n -u awbs-agent -- /usr/local/libexec/awbs-agent-exec <하위 명령> ...
# 왜 래퍼를 두나: CLI 인자(모델·세션 ID)는 매번 달라 sudoers에 다 적을 수 없다.
#   그래서 sudoers는 「이 래퍼만」 허용하고, 무엇을 실행해도 되는지는 이 래퍼가 검사한다.
#
# 하위 명령
#   run --agent claude|codex --cwd <작업 폴더> [--env LANG=값]... -- <CLI 진입점> [인자...]
#                       CLI 진입점은 $AGENT_ROOT/cli/<agent>/<버전>/bin/<agent> 하나뿐이다(조정자 결정 4).
#   ci-run --cwd <작업 폴더> [--env 이름=값]... -- <명령> [인자...]
#                       ①·CI 검사 명령(Agent 코드의 시험·빌드)을 Agent 계정으로 실행한다(조정자 결정 1).
#                       명령은 이름(예: pnpm)이면 고정 PATH에서, 경로면 작업 폴더 안에서만 찾는다.
#                       --home <작업 폴더>/.awbs-home 필수: 실행마다 새 HOME·TMPDIR(pnpm 저장소 포함)를 그 사본 안에 둔다(조정자 결정 8).
#   git-inspect --cwd <작업 폴더>       작업 폴더의 HEAD와 「커밋하지 않은 변경이 있는가」를 Agent 계정 git으로 본다(조정자 결정 6)
#   git-bundle --cwd <작업 폴더> --branch <이름>   그 브랜치의 git bundle(데이터 파일)을 표준 출력으로 낸다(조정자 결정 6)
#   cli-version --tool claude|codex|pnpm -- <진입점>   새로 설치한 CLI의 --version을 Agent 계정으로 실행한다(조정자 결정 8)
#   agent-file read|write|remove --cwd <작업 폴더> --path <.claude|.codex>/agents/<이름>
#                       하위 Agent 정의 파일을 Agent 계정이 읽고(표준 출력)·쓰고(표준 입력)·지운다(fix2 추가, 조정자 지시).
#                       없는 파일 읽기는 종료 코드 3. Runner는 Agent가 쓸 수 있는 폴더에 직접 쓰지 않는다.
#
# 주의: 이 래퍼는 Runner를 막는 보안 경계가 아니다. Runner 계정을 Agent 계정으로 바꾸는 「문」이다.
#   ci-run은 고정 PATH의 아무 명령이나 받는다. 결정 4(「run은 진입점만」)는 run 하위 명령 안의 규칙일 뿐이다.
#   경계는 「Agent 계정이 Runner 홈·토큰에 닿지 못한다」와 「Runner 계정이 Agent가 쓴 것을 실행·해석하지 않는다」다.
#   kill-group <pgid>   그 프로세스 그룹의 awbs-agent 프로세스를 모두 강제 종료
#   kill-all            awbs-agent 계정의 프로세스를 모두 강제 종료(세션이 0일 때 남은 것 청소)
#   fix-perms <경로>     작업 폴더 안 Agent 파일에 Runner 계정의 읽기·쓰기 권한을 되돌려 줌
#   check               격리 상태 점검(Runner 준비 점검이 부른다). 통과하면 「ok」 출력
#   login-status --agent claude|codex -- <CLI 실행 파일>
#                       Agent 계정의 로그인 상태를 본다(정해진 인자만, 돈이 들지 않음). CLI의 출력을 그대로 돌려준다
# bash 전용이다. sh(dash)로 부르면 pipefail에서 알 수 없는 오류가 나므로 여기서 먼저 멈춘다.
if [ -z "${BASH_VERSION:-}" ]; then echo "bash로 실행하세요. 예: bash $0" >&2; exit 2; fi
set -euo pipefail
umask 0007

# 설정 파일 위치는 고정한다. 환경 변수로 바꾸지 못하게 해서 sudo 호출자가 다른 설정을 끼워 넣지 못하게 한다.
CONF=/etc/agentwbs/agent-exec.conf

die() { printf 'awbs-agent-exec: %s\n' "$1" >&2; exit "${2:-2}"; }

# 설정 파일은 실행(source)하지 않고, 정해진 이름만 한 줄씩 읽는다(설정 파일에 명령을 숨겨도 실행되지 않게).
AGENT_USER='' RUNNER_USER='' RUNNER_HOME='' AGENT_ROOT='' NODE_DIR=''
[[ -f $CONF ]] || die "설정 파일이 없습니다: $CONF"
while IFS='=' read -r key value; do
  [[ -z $key || $key == \#* ]] && continue
  case $key in
    AGENT_USER | RUNNER_USER) [[ $value =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "설정 값이 올바르지 않습니다: $key" ;;
    # 정규화된 절대 경로만: `..`·`//`·끝 `/`가 있으면 같은 곳의 다른 표기라 비교가 어긋난다.
    RUNNER_HOME | AGENT_ROOT | NODE_DIR)
      [[ $value =~ ^/[A-Za-z0-9._/-]+$ && $value != *..* && $value != *//* && $value != */ ]] || die "설정 값이 올바르지 않습니다: $key" ;;
    *) die "모르는 설정 이름입니다: $key" ;;
  esac
  printf -v "$key" '%s' "$value"
done < "$CONF"
for key in AGENT_USER RUNNER_USER RUNNER_HOME AGENT_ROOT NODE_DIR; do
  [[ -n ${!key} ]] || die "설정에 $key가 없습니다."
done

# 이 래퍼는 Agent 계정으로만 돈다. Runner 계정이나 root로 직접 부르면 격리된 것처럼 보이기만 하므로 거부한다.
[[ $(id -un) == "$AGENT_USER" ]] || die "Agent 계정($AGENT_USER)으로만 실행합니다. 현재: $(id -un)" 3

# 작업 폴더를 먼저 루트(/)로 옮긴다. sudo는 부른 쪽의 현재 폴더(예: Runner 홈)를 그대로 물려주는데,
# Agent는 그 폴더에 들어갈 수 없다. 그 상태에서 GNU find는 끝날 때 「처음 폴더로 돌아갈 수 없음」으로 실패해
# check가 cli_unverified·inputs_unverified를 내고 fix-perms도 실패한다(owner 설치 1차 실패 원인).
cd / || die "루트 폴더(/)로 옮기지 못했습니다."

# 기준 폴더도 실제 경로로 바꿔 둔다. 비교하는 양쪽을 같은 방법으로 정규화해야 한다.
WORKTREES=$(realpath -e -- "$AGENT_ROOT/worktrees" 2> /dev/null) || die "작업 폴더 모음이 없습니다."
CLI_DIR=$(realpath -e -- "$AGENT_ROOT/cli" 2> /dev/null) || die "CLI 폴더가 없습니다."
INPUTS_DIR=$(realpath -e -- "$AGENT_ROOT/inputs" 2> /dev/null) || die "입력 자료 폴더가 없습니다."
AGENT_HOME=$(getent passwd "$AGENT_USER" | cut -d: -f6)
[[ -n $AGENT_HOME && -d $AGENT_HOME ]] || die "Agent 계정의 홈 폴더가 없습니다."

# Agent 계정의 고정 PATH. ci-run도 같은 PATH를 쓴다. pnpm은 Runner가 설치한 $CLI_DIR/pnpm/current/bin에서 찾는다.
AGENT_PATH="$NODE_DIR:$CLI_DIR/pnpm/current/bin:/usr/local/bin:/usr/bin:/bin"

# 경로를 링크까지 모두 따라간 실제 경로로 바꾸고, 기준 폴더 「안」에 있는지 본다(기준 폴더 자체는 안 됨).
inside() {
  local real
  real=$(realpath -e -- "$1" 2> /dev/null) || return 1
  [[ $real == "$2"/* ]] || return 1
  printf '%s' "$real"
}

# CLI 진입점 검사(조정자 결정 4). 허용하는 모양은 $CLI_DIR/<agent>/<버전>/bin/<agent> 하나다.
# - <버전>은 숫자.숫자.숫자이고 링크가 아닌 실제 폴더다(current 링크는 Runner가 실행 시점의 버전으로 바꿔 넘긴다).
# - 진입점은 보통 패키지 안 파일을 가리키는 링크다. 링크를 따라간 실제 파일도 그 버전 폴더 안이어야 한다.
# 왜: CLI 묶음 안에는 rg·bwrap 같은 다른 실행 파일도 있다. bwrap은 임의 명령을 띄울 수 있으므로 진입점만 받는다.
#   CLI가 세션 안에서 스스로 부르는 rg 등은 같은 계정·같은 scope의 자식이라 따로 허용할 필요가 없다.
# 출력: 진입점 경로(링크 그대로). CLI는 자기 위치로 패키지를 찾으므로 링크 경로로 실행한다.
entry_point() {
  local agent=$1 path=$2 version dir real
  [[ $path =~ ^/[A-Za-z0-9._/-]+$ && $path != *..* && $path != *//* ]] || return 1
  [[ $path == "$CLI_DIR/$agent/"*"/bin/$agent" ]] || return 1
  version=${path#"$CLI_DIR/$agent/"}
  version=${version%"/bin/$agent"}
  [[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || return 1
  dir=$CLI_DIR/$agent/$version
  [[ -d $dir && ! -L $dir && ! -L $dir/bin ]] || return 1
  real=$(realpath -e -- "$path" 2> /dev/null) || return 1
  [[ $real == "$dir"/* && -f $real && -x $real ]] || return 1
  printf '%s' "$path"
}

cmd_run() {
  local agent='' cwd='' extra=()
  while (($#)); do
    [[ $1 == -- ]] || (($# >= 2)) || die "옵션 값이 없습니다: $1"
    case $1 in
      --agent) agent=$2; shift 2 ;;
      --cwd) cwd=$2; shift 2 ;;
      --env)
        # 넘겨도 되는 값은 언어 설정 둘뿐이다. 토큰·키 같은 다른 값은 이름부터 거부한다.
        [[ $2 =~ ^(LANG|LC_ALL)=[A-Za-z0-9_.@-]{1,64}$ ]] || die "허용하지 않는 환경 변수입니다: ${2%%=*}"
        extra+=("$2"); shift 2 ;;
      --) shift; break ;;
      *) die "모르는 옵션입니다: $1" ;;
    esac
  done
  [[ $agent == claude || $agent == codex ]] || die "--agent는 claude 또는 codex입니다."
  (($# >= 1)) || die "실행할 CLI가 없습니다."
  local real_cwd real_bin
  real_cwd=$(inside "$cwd" "$WORKTREES") || die "작업 폴더는 $WORKTREES 안이어야 합니다."
  [[ -d $real_cwd ]] || die "작업 폴더가 폴더가 아닙니다."
  real_bin=$(entry_point "$agent" "$1") || die "CLI는 $CLI_DIR/$agent/<버전>/bin/$agent 진입점이어야 합니다."
  shift
  cd -- "$real_cwd"
  # env -i: Runner에게서 받은 환경을 모두 버리고 아래 값만 새로 만든다.
  # HOME은 Agent 계정의 홈이다. Claude·Codex 로그인 정보도 이 홈(~/.claude, ~/.codex)에서 읽는다.
  exec env -i \
    HOME="$AGENT_HOME" USER="$AGENT_USER" LOGNAME="$AGENT_USER" \
    PATH="$AGENT_PATH" \
    TMPDIR="$AGENT_HOME/tmp" \
    DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 \
    "${extra[@]}" \
    "$real_bin" "$@"
}

# Agent 계정의 Claude·Codex 로그인 상태(무과금). 인자는 래퍼가 정한다: Runner가 다른 명령을 끼워 넣지 못하게.
cmd_login_status() {
  local agent=''
  [[ ${1-} == --agent ]] && { agent=${2-}; shift 2; }
  [[ ${1-} == -- ]] && shift
  [[ $agent == claude || $agent == codex ]] || die "--agent는 claude 또는 codex입니다."
  (($# == 1)) || die "CLI 실행 파일 하나만 받습니다."
  local real_bin
  real_bin=$(entry_point "$agent" "$1") || die "CLI는 $CLI_DIR/$agent/<버전>/bin/$agent 진입점이어야 합니다."
  local args=(auth status --json)
  [[ $agent == codex ]] && args=(-c check_for_update_on_startup=false login status)
  cd -- "$AGENT_HOME"
  exec env -i HOME="$AGENT_HOME" USER="$AGENT_USER" LOGNAME="$AGENT_USER" \
    PATH="$AGENT_PATH" TMPDIR="$AGENT_HOME/tmp" \
    DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 "$real_bin" "${args[@]}"
}

# ①·CI 검사 명령(조정자 결정 1). Runner가 main에 고정된 pipeline.yaml에서 만든 argv만 보낸다.
# 래퍼는 그 출처를 알 수 없으므로 실행 범위를 막는다: 작업 폴더는 worktrees 안, 환경 변수는 허용 목록, 계정은 Agent.
# 왜 계정을 바꾸나: 시험·빌드는 Agent가 쓴 코드(설정 파일·스크립트)를 실행한다. Runner 계정으로 돌리면 Runner 홈·토큰에 닿는다.
cmd_ci_run() {
  local cwd='' home='' extra=()
  while (($#)); do
    [[ $1 == -- ]] || (($# >= 2)) || die "옵션 값이 없습니다: $1"
    case $1 in
      --cwd) cwd=$2; shift 2 ;;
      --home) home=$2; shift 2 ;;
      --env)
        # 검사 명령에 넘겨도 되는 이름만. 값은 경로·숫자·짧은 낱말 모양만 받는다(줄바꿈·공백·따옴표 없음).
        [[ $2 =~ ^(LANG|LC_ALL|TZ|CI|NODE_ENV|FORCE_COLOR|NO_COLOR|AWBS_REPORT|AWBS_REPORT_NONCE|AWBS_EVIDENCE_DIR)=[A-Za-z0-9_.@:/+,=-]{0,512}$ ]] \
          || die "허용하지 않는 환경 변수입니다: ${2%%=*}"
        extra+=("$2"); shift 2 ;;
      --) shift; break ;;
      *) die "모르는 옵션입니다: $1" ;;
    esac
  done
  (($# >= 1)) || die "실행할 명령이 없습니다."
  local real_cwd program
  real_cwd=$(inside "$cwd" "$WORKTREES") || die "작업 폴더는 $WORKTREES 안이어야 합니다."
  [[ -d $real_cwd ]] || die "작업 폴더가 폴더가 아닙니다."
  # 실행마다 새 HOME(조정자 결정 8): 그 검사 사본 안의 .awbs-home(Runner가 사본을 만들 때 함께 만든 실제 폴더)만 받는다.
  # 왜: Agent 계정 HOME(pnpm 저장소·캐시)을 모든 Task가 같이 쓰면 다른 Task의 Agent가 이 검사의 의존성을 바꿀 수 있다.
  [[ $home == "$cwd/.awbs-home" && -d $home && ! -L $home ]] || die "--home은 작업 폴더 안의 .awbs-home 폴더여야 합니다."
  local real_home
  real_home=$(inside "$home" "$real_cwd") || die "--home은 작업 폴더 안이어야 합니다."
  mkdir -p -- "$real_home/tmp"
  cd -- "$real_cwd"
  if [[ $1 == */* ]]; then
    # 경로로 준 명령(예: ./node_modules/.bin/vitest)은 작업 폴더 안의 실행 파일만.
    program=$(inside "$1" "$real_cwd") || die "경로로 준 명령은 작업 폴더 안이어야 합니다."
    [[ -f $program && -x $program ]] || die "실행 파일이 아닙니다."
    program=$1
  else
    [[ $1 =~ ^[A-Za-z0-9._+-]{1,64}$ ]] || die "명령 이름 형식이 아닙니다."
    program=$(PATH="$AGENT_PATH" command -v -- "$1") || die "고정 PATH에서 명령을 찾지 못했습니다: $1"
    [[ $program == /* ]] || die "고정 PATH의 실행 파일이 아닙니다: $1"
  fi
  shift
  # GIT_CONFIG_*: 검사 명령 안의 git(예: 시험 도구의 변경 파일 조회)이 이 사본(Runner 계정 소유)을 「dubious ownership」으로
  #   거부하지 않게 이 폴더만 허용한다. 실행마다 새 HOME이라 Agent 계정의 전역 설정(safe.directory '*')이 없다.
  exec env -i \
    HOME="$real_home" USER="$AGENT_USER" LOGNAME="$AGENT_USER" \
    PATH="$AGENT_PATH" \
    TMPDIR="$real_home/tmp" \
    DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$real_cwd" \
    "${extra[@]}" \
    "$program" "$@"
}

# Agent 계정 git(조정자 결정 6). Runner 계정은 Agent가 쓸 수 있는 저장소에서 git을 돌리지 않는다.
# 왜: git은 저장소 설정(.git/config)의 많은 키로 명령을 실행한다(filter·partialClone uploadpack 등). 옵션으로 하나씩 끌 수 없다.
#   그래서 Agent 작업 폴더의 git은 Agent 계정이 돌린다. 설정이 무엇을 실행하든 Agent 권한이다.
# 안전 기본값: 시스템·전역 설정 없음, 원격 전송 금지(GIT_ALLOW_PROTOCOL=none), 늦은 가져오기 금지, hook·fsmonitor 끔.
# safe.directory: 작업 폴더는 Runner 계정이 만든 것이라(.prep-<uuid>에서 준비 뒤 넘김) 소유자가 Agent 계정과 다르다.
#   git은 소유자가 다른 저장소를 「dubious ownership」으로 거부하므로, 이 한 폴더만 명령줄 설정(보호 설정)으로 허용한다.
#   왜 명령줄인가: 저장소 설정(.git/config)의 safe.directory는 git이 읽지 않는다. Agent가 저장소 설정으로 넓힐 수 없다.
agent_git() {
  local dir=$1; shift
  env -i HOME="$AGENT_HOME" USER="$AGENT_USER" LOGNAME="$AGENT_USER" PATH=/usr/bin:/bin \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ALLOW_PROTOCOL=none GIT_NO_LAZY_FETCH=1 \
    GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LANG=C.UTF-8 \
    git -C "$dir" -c safe.directory="$dir" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.excludesFile=/dev/null "$@"
}

git_cwd() {
  local cwd=${2-}
  [[ ${1-} == --cwd && -n $cwd ]] || die "--cwd가 필요합니다."
  local real
  real=$(inside "$cwd" "$WORKTREES") || die "작업 폴더는 $WORKTREES 안이어야 합니다."
  [[ -d $real && -e $real/.git ]] || die "git 작업 폴더가 아닙니다."
  printf '%s' "$real"
}

# 출력: 「head <40자 SHA>」 한 줄, 「dirty 0|1」 한 줄. 커밋하지 않은 변경·추적 안 된 파일·assume-unchanged/skip-worktree 표시가 있으면 dirty 1.
cmd_git_inspect() {
  (($# == 2)) || die "git-inspect --cwd <작업 폴더>만 받습니다."
  local dir head status flags
  dir=$(git_cwd "$@")
  head=$(agent_git "$dir" rev-parse --verify 'HEAD^{commit}') || die "HEAD를 읽지 못했습니다."
  [[ $head =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || die "HEAD 모양이 아닙니다."
  status=$(agent_git "$dir" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none | tr '\0' '\n') || die "상태를 읽지 못했습니다."
  flags=$(agent_git "$dir" ls-files -v | grep -E '^[a-zS] ' || true)
  printf 'head %s\n' "$head"
  if [[ -n $status || -n $flags ]]; then echo 'dirty 1'; else echo 'dirty 0'; fi
}

# 브랜치 하나의 전체 기록을 bundle로 표준 출력에 쓴다. Runner는 이 데이터만 받아 자기 bare 저장소에서 verify 뒤 fetch한다.
cmd_git_bundle() {
  (($# == 4)) && [[ $3 == --branch ]] || die "git-bundle --cwd <작업 폴더> --branch <이름>만 받습니다."
  local dir branch=$4
  dir=$(git_cwd "$1" "$2")
  [[ $branch =~ ^[A-Za-z0-9._/-]{1,200}$ && $branch != *..* && $branch != */ && $branch != /* ]] || die "브랜치 이름 모양이 아닙니다."
  agent_git "$dir" check-ref-format --branch "$branch" > /dev/null || die "브랜치 이름 모양이 아닙니다."
  agent_git "$dir" bundle create --quiet - "refs/heads/$branch"
}

# 새로 설치한 CLI의 --version(조정자 결정 8). 모양은 run 진입점 규칙과 같고, pnpm도 받는다.
cmd_cli_version() {
  local tool=''
  [[ ${1-} == --tool ]] && { tool=${2-}; shift 2; }
  [[ ${1-} == -- ]] && shift
  [[ $tool == claude || $tool == codex || $tool == pnpm ]] || die "--tool은 claude·codex·pnpm입니다."
  (($# == 1)) || die "진입점 하나만 받습니다."
  local bin
  bin=$(entry_point "$tool" "$1") || die "진입점은 $CLI_DIR/$tool/<버전>/bin/$tool이어야 합니다."
  cd -- "$AGENT_HOME"
  exec env -i HOME="$AGENT_HOME" USER="$AGENT_USER" LOGNAME="$AGENT_USER" PATH="$AGENT_PATH" TMPDIR="$AGENT_HOME/tmp" \
    DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 "$bin" --version
}

# 하위 Agent 정의 파일(fix2 추가). Runner 계정이 Agent 작업 폴더에 쓰면 lstat 확인과 쓰기 사이에
# 다른 Agent 세션이 폴더를 Runner 폴더 링크로 바꿔 Runner 파일을 덮어쓸 수 있다. 그래서 읽기·쓰기·지우기를 Agent 계정이 한다.
# 링크를 따라가도 Agent 권한이라 넓어지지 않는다. 경로는 정해진 모양만, 크기는 1 MiB까지.
cmd_agent_file() {
  (($# == 5)) && [[ $2 == --cwd && $4 == --path ]] || die "agent-file read|write|remove --cwd <작업 폴더> --path <경로>만 받습니다."
  local op=$1 rel=$5 real_cwd
  [[ $op == read || $op == write || $op == remove ]] || die "agent-file 동작은 read·write·remove입니다."
  [[ $rel =~ ^\.(claude|codex)/agents/(\.awbs-installed\.json|[a-z][a-z0-9-]{0,63}\.(md|toml))$ ]] || die "하위 Agent 정의 경로 모양이 아닙니다."
  real_cwd=$(inside "$3" "$WORKTREES") || die "작업 폴더는 $WORKTREES 안이어야 합니다."
  [[ -d $real_cwd ]] || die "작업 폴더가 폴더가 아닙니다."
  cd -- "$real_cwd"
  case $op in
    read)
      [[ -e $rel || -L $rel ]] || exit 3
      [[ -f $rel && ! -L $rel ]] || die "일반 파일이 아닙니다."
      head -c 1048577 -- "$rel" ;;
    write)
      local dir tmp
      dir=${rel%/*}
      mkdir -p -- "$dir"
      tmp=$(mktemp -- "$dir/.awbs-XXXXXX")
      head -c 1048577 > "$tmp"
      (($(stat -c %s -- "$tmp") <= 1048576)) || { rm -f -- "$tmp"; die "파일이 너무 큽니다."; }
      chmod 0660 -- "$tmp"
      mv -fT -- "$tmp" "$rel" ;;
    remove) rm -f -- "$rel" ;;
  esac
}

cmd_kill_group() {
  [[ ${1-} =~ ^[1-9][0-9]{0,9}$ ]] || die "pgid는 양의 정수입니다."
  # Agent 계정으로 보내므로 Agent 계정의 프로세스에만 닿는다. 다른 계정(Runner·root)의 프로세스는 죽일 수 없다.
  if kill -0 -- "-$1" 2> /dev/null; then
    kill -KILL -- "-$1" 2> /dev/null || true
    echo killed
  else
    echo none
  fi
}

cmd_kill_all() {
  # -1: 이 계정이 신호를 보낼 수 있는 모든 프로세스(=Agent 계정 프로세스). 자기 자신은 빠진다.
  kill -KILL -1 2> /dev/null || true
  echo killed
}

cmd_fix_perms() {
  local real
  real=$(inside "${1-}" "$WORKTREES") || die "경로는 $WORKTREES 안이어야 합니다."
  # Runner는 이 명령 전에 그 세션의 Agent 프로세스를 모두 끝내야 한다(끝나지 않으면 권한을 다시 지울 수 있다).
  # 링크는 따라가지 않는다(-P). Agent가 소유한 것만 고친다.
  # 폴더는 「들어가기 전에」 하나씩 바로 고친다(-exec ... \;). 모아서 나중에 고치면(+) 권한 000인 폴더 안을 못 읽는다.
  # 마지막에 Runner 계정에 읽기·쓰기·들어가기 ACL을 준다(m::rwX = 이름 있는 항목의 상한도 함께 연다).
  # 고치지 못한 항목은 -print로 이름이 나온다. 하나라도 나오거나 find가 어떤 폴더를 못 읽으면 실패다.
  local missed
  if ! missed=$(find -P "$real" ! -type l -user "$AGENT_USER" \( \
    \( -type d -exec chmod u+rwx,g+rwx {} \; -exec setfacl -m "u:$RUNNER_USER:rwx,m::rwx" {} \; \) -o \
    \( ! -type d -exec chmod u+rw,g+rw {} \; -exec setfacl -m "u:$RUNNER_USER:rwX,m::rwX" {} \; \) -o \
    -print \)) || [[ -n $missed ]]; then
    die "권한을 모두 되돌리지 못했습니다. 작업 폴더를 지우지 마세요." 4
  fi
  echo fixed
}

# 그 폴더 아래(자신 포함)에 Agent가 쓸 수 있는 것이 하나라도 있으면 성공(0). 다 읽지 못하면 2(=확인 못 함).
writable_below() {
  local found
  found=$(find -P "$1" -writable -print -quit 2> /dev/null) || return 2
  [[ -n $found ]]
}

cmd_check() {
  local failed=0 rc
  fail() { printf 'fail %s\n' "$1"; failed=1; }
  # Runner의 홈(~/.agentwbs, ~/.config/gh, 다른 프로젝트가 있는 곳)에 들어가거나 목록을 볼 수 없어야 한다.
  if [[ -x $RUNNER_HOME || -r $RUNNER_HOME ]]; then fail runner_home_accessible; fi
  # WSL: Windows 드라이브(/mnt), Docker Desktop이 붙인 Windows 폴더(/Docker), Windows 프로그램 실행 통로(/run/WSL).
  # 목록 읽기(-r)와 지나가기(-x)를 따로 본다. 목록이 막혀도 이름을 알면 지나갈 수 있기 때문이다.
  if [[ -x /mnt || -r /mnt ]]; then fail mnt_accessible; fi
  if [[ -e /Docker ]] && [[ -x /Docker || -r /Docker ]]; then fail docker_mount_accessible; fi
  if [[ -e /run/WSL ]] && [[ -x /run/WSL || -r /run/WSL ]]; then fail wsl_interop_accessible; fi
  if [[ -r /var/run/docker.sock || -w /var/run/docker.sock ]]; then fail docker_socket_accessible; fi
  # Runner가 설치한 CLI는 읽고 실행만. 맨 위 폴더만이 아니라 버전 폴더·실행 파일까지 하나도 쓸 수 없어야 한다.
  if [[ ! -r $CLI_DIR || ! -x $CLI_DIR ]]; then fail cli_unreadable; fi
  rc=0; writable_below "$CLI_DIR" || rc=$?
  case $rc in 0) fail cli_writable ;; 2) fail cli_unverified ;; esac
  # 입력 자료 사본도 안쪽 파일까지 하나도 쓸 수 없어야 한다.
  rc=0; writable_below "$INPUTS_DIR" || rc=$?
  case $rc in 0) fail inputs_writable ;; 2) fail inputs_unverified ;; esac
  if [[ ! -x $NODE_DIR/node ]]; then fail node_missing; fi
  # DNS 설정을 읽을 수 있어야 Claude·Codex 서버 이름을 찾는다. WSL 링크(/etc/resolv.conf → /mnt/wsl/...)가 그대로면
  # /mnt가 막힌 Agent는 못 읽는다(fix7). 설정 파일이 아예 없는 PC는 여기서 보지 않는다.
  if [[ -e /etc/resolv.conf || -L /etc/resolv.conf ]] && [[ ! -r /etc/resolv.conf ]]; then fail resolv_unreadable; fi
  if ((failed == 0)); then echo ok; fi
  return "$failed"
}

sub=${1-}
(($#)) && shift
case $sub in
  run) cmd_run "$@" ;;
  ci-run) cmd_ci_run "$@" ;;
  git-inspect) cmd_git_inspect "$@" ;;
  git-bundle) cmd_git_bundle "$@" ;;
  cli-version) cmd_cli_version "$@" ;;
  agent-file) cmd_agent_file "$@" ;;
  kill-group) cmd_kill_group "$@" ;;
  kill-all) cmd_kill_all ;;
  fix-perms) cmd_fix_perms "$@" ;;
  check) cmd_check ;;
  login-status) cmd_login_status "$@" ;;
  *) die "하위 명령은 run · ci-run · git-inspect · git-bundle · cli-version · agent-file · kill-group · kill-all · fix-perms · check · login-status 중 하나입니다." ;;
esac
