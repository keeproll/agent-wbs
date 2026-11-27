#!/usr/bin/env bash
# Agent 계정이 쓸 Claude·Codex CLI를 Agent 작업 영역(/srv/agentwbs/cli)에 「최신 버전」으로 설치·갱신한다(owner Q-12).
# owner가 Runner 계정(keeproll)으로 실행한다. 관리자 권한(sudo)은 쓰지 않는다(이 폴더의 주인이 Runner 계정이라서).
#
#   bash agent-runner/scripts/isolation/install-agent-cli.sh --dry-run   # 무엇을 할지 보기만
#   bash agent-runner/scripts/isolation/install-agent-cli.sh             # 최신 버전 설치(이미 최신이면 그대로)
#
# 언제 쓰나
#   - 처음 한 번: 설치 스크립트(setup-agent-user.sh) 뒤, Agent 계정 로그인 「전」에. 로그인할 프로그램이 있어야 하기 때문이다.
#   - 그 뒤로는 Runner가 시작할 때와 매일 최신 버전을 확인하고, 실행 중인 세션이 없을 때 바꾼다(architecture §5.1).
#     Runner를 오래 끄고 있었거나 바로 최신으로 맞추고 싶을 때만 Runner를 멈춘 상태에서 다시 실행한다.
#
# 하는 일(Runner의 CLI 업데이트와 같은 방식·같은 폴더 모양)
#   1. npm 공식 저장소에서 @anthropic-ai/claude-code, @openai/codex의 latest 버전 번호를 읽는다.
#   2. /srv/agentwbs/cli/<claude|codex>/<버전>/ 에 설치한다(임시 폴더에 설치 → 점검 → 이름 바꾸기).
#   3. 설치한 프로그램이 그 버전을 말하는지(--version) 확인한다. 돈이 드는 호출은 하지 않는다.
#   4. current 링크를 새 버전으로 한 번에 바꾼다.
# bash 전용이다. sh(dash)로 부르면 pipefail에서 알 수 없는 오류가 나므로 여기서 먼저 멈춘다.
if [ -z "${BASH_VERSION:-}" ]; then echo "bash로 실행하세요. 예: bash $0" >&2; exit 2; fi
set -euo pipefail
# 새 파일·폴더에 그룹 쓰기를 주지 않는다(리뷰5 P3-5). 이 폴더의 그룹은 Agent 계정이라, 그룹 쓰기가 생기면 Agent가 CLI를 고칠 수 있다.
# 실행한 셸의 umask(예: 0002)를 따르지 않고 여기서 직접 정한다. 지금 런북 환경(umask 0022)에서는 결과가 같다.
umask 0022

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$HERE/common.sh"

while (($#)); do
  case $1 in
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "모르는 옵션입니다: $1" 2 ;;
  esac
done

step '0. 사전 확인(관리자 권한 없음)'
RUNNER_USER=$(id -un)
[[ $(id -u) != 0 && $RUNNER_USER != root && $RUNNER_USER != "$AGENT_USER" ]] || die 'Runner 계정(예: keeproll)으로 실행하세요.'
command -v npm > /dev/null || die 'npm을 찾지 못했습니다. Runner를 돌리는 터미널(node·npm이 있는 곳)에서 실행하세요.'
CLI_ROOT=$AGENT_ROOT/cli
if ((!DRY_RUN)); then
  [[ -d $CLI_ROOT && ! -L $CLI_ROOT ]] || die "$CLI_ROOT가 없습니다. setup-agent-user.sh를 먼저 실행하세요."
  [[ $(stat -c %U -- "$CLI_ROOT") == "$RUNNER_USER" || -n $ROOT_PREFIX ]] || die "$CLI_ROOT의 주인이 $RUNNER_USER가 아닙니다."
  [[ -w $CLI_ROOT ]] || die "$CLI_ROOT에 쓸 수 없습니다."
fi
# Runner의 CLI 업데이트(src/cli-update/registry.ts)와 같은 npm 설정: 공식 저장소만, 사용자 npm 설정은 읽지 않음.
NPM_HOME=$CLI_ROOT
if ((DRY_RUN)); then
  # dry-run은 작업 영역이 아직 없을 수 있어 npm 캐시를 Runner 계정의 임시 폴더에 둔다(버전 번호 읽기에만 씀).
  NPM_HOME=$(mktemp -d)
  trap 'rm -rf -- "$NPM_HOME"' EXIT
fi
NPM_FLAGS=(--global --registry=https://registry.npmjs.org --userconfig=/dev/null "--globalconfig=$NPM_HOME/.npm-empty-globalconfig"
  "--cache=$NPM_HOME/.npm-cache" --no-update-notifier)
note "설치 위치: $CLI_ROOT"
((DRY_RUN)) && note 'dry-run: 설치·링크 변경은 하지 않고 보여 주기만 합니다(버전 확인은 실제로 함).'

# 한 줄씩 보여 주고 실행한다. dry-run이면 보여 주기만 한다.
act() {
  printf '   $'
  printf ' %q' "$@"
  printf '\n'
  ((DRY_RUN)) || "$@"
}

FAILED=0
for agent in claude codex; do
  pkg=@openai/codex
  scripts=()
  if [[ $agent == claude ]]; then pkg=@anthropic-ai/claude-code; scripts=(--allow-scripts=@anthropic-ai/claude-code); fi
  step "$agent ($pkg)"
  if ! raw=$(npm view "$pkg@latest" version --json "${NPM_FLAGS[@]}" 2> /dev/null); then
    note '최신 버전을 읽지 못했습니다(네트워크·npm 확인).'; FAILED=1; continue
  fi
  # npm은 "1.2.3" 또는 ["1.2.3"] 모양으로 답한다. Runner(registry.ts)처럼 마지막 값을 쓴다.
  latest=$(printf '%s' "$raw" | tr -d '"[:space:][]' | awk -F, '{ print $NF }')
  # 안정판 번호(숫자.숫자.숫자)만 받는다. 이상한 값을 폴더 이름으로 쓰지 않기 위해서다.
  [[ $latest =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { note "최신 버전 형식이 아닙니다: $latest"; FAILED=1; continue; }
  base=$CLI_ROOT/$agent
  current=''
  [[ -L $base/current ]] && current=$(readlink -- "$base/current")
  note "최신: $latest · 지금: ${current:-없음}"
  if [[ $current == "$latest" ]]; then note '이미 최신입니다.'; continue; fi
  act mkdir -p -m 0750 -- "$base"                                       # 이 CLI의 폴더(Agent 그룹은 읽기·실행만)
  if [[ -d $base/$latest ]]; then
    note "버전 폴더가 이미 있어 설치는 건너뜁니다: $base/$latest"
  elif ((DRY_RUN)); then
    act mkdir -m 0750 -- "$base/.install-XXXXXX"
    act npm install --prefix "$base/.install-XXXXXX" "$pkg@$latest" "${NPM_FLAGS[@]}" --no-audit --no-fund "${scripts[@]}"
    act mv -T -- "$base/.install-XXXXXX" "$base/$latest"
  else
    stage=$(mktemp -d "$base/.install-XXXXXX")
    chmod 0750 "$stage"                                                  # Agent 그룹이 들어갈 수 있게(쓰기는 없음)
    if ! act npm install --prefix "$stage" "$pkg@$latest" "${NPM_FLAGS[@]}" --no-audit --no-fund "${scripts[@]}"; then
      rm -rf -- "$stage"; note '설치 실패. 이전 버전을 그대로 둡니다.'; FAILED=1; continue
    fi
    bin=$stage/bin/$agent
    # 실행 파일이 설치 폴더 안에 있고, 그 버전을 말하는지 본다(돈이 드는 호출 없음).
    real=$(realpath -e -- "$bin" 2> /dev/null || true)
    if [[ $real != "$stage"/* ]] || ! "$bin" --version 2> /dev/null | grep -Fq "$latest"; then
      rm -rf -- "$stage"; note '설치한 CLI 점검 실패. 이전 버전을 그대로 둡니다.'; FAILED=1; continue
    fi
    act mv -T -- "$stage" "$base/$latest"
  fi
  # current 링크를 한 번에 바꾼다(임시 링크를 만든 뒤 이름 바꾸기). 실행 중인 세션은 이미 실제 경로로 고정돼 영향이 없다.
  act ln -s -- "$latest" "$base/.current-new"
  act mv -T -- "$base/.current-new" "$base/current"
  note "current → $latest"
done

step '끝'
if ((FAILED)); then
  note '일부 CLI를 설치하지 못했습니다. 위 메시지를 보내 주세요.'
  exit 1
fi
note '다음: Agent 계정으로 Claude·Codex에 로그인합니다(OWNER-RUNBOOK.md 4단계).'
((DRY_RUN)) && printf '\n(dry-run이라 설치·링크는 바꾸지 않았습니다.)\n'
exit 0
