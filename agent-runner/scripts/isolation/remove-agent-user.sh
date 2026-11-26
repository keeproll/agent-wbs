#!/usr/bin/env bash
# Agent 전용 OS 계정 되돌리기(setup-agent-user.sh의 반대). owner가 Runner 계정으로 실행한다.
#
#   bash agent-runner/scripts/isolation/remove-agent-user.sh --dry-run        # 무엇을 지울지 보기만
#   bash agent-runner/scripts/isolation/remove-agent-user.sh                  # 계정·래퍼·규칙 제거(작업 영역은 남김)
#   bash agent-runner/scripts/isolation/remove-agent-user.sh --purge-work     # 작업 영역(/srv/agentwbs)까지 삭제
#
# 옵션
#   --dry-run          관리자 명령을 실행하지 않고 보여 주기만 한다.
#   --purge-work       작업 영역 전체(작업 폴더·입력 사본·CLI 설치본)도 지운다. 기본은 남긴다.
#   --agent-user 이름   Agent 계정 이름(기본 awbs-agent)
#   --agent-root 경로   Agent 작업 영역(기본 /srv/agentwbs)
#
# 실행 전에 Runner를 멈추세요. 실행 중인 Agent 세션은 이 스크립트가 강제로 끝냅니다.
# bash 전용이다. sh(dash)로 부르면 pipefail에서 알 수 없는 오류가 나므로 여기서 먼저 멈춘다.
if [ -z "${BASH_VERSION:-}" ]; then echo "bash로 실행하세요. 예: bash $0" >&2; exit 2; fi
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$HERE/common.sh"

PURGE=0
while (($#)); do
  case $1 in
    --dry-run) DRY_RUN=1; shift ;;
    --purge-work) PURGE=1; shift ;;
    --agent-user) AGENT_USER=${2-}; shift 2 ;;
    --agent-root) AGENT_ROOT=${2-}; shift 2 ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "모르는 옵션입니다: $1" 2 ;;
  esac
done

step '0. 사전 확인(관리자 권한 필요 없음)'
[[ $(id -u) != 0 ]] || die 'root가 아니라 Runner 계정으로 실행하세요.'
valid_user "$AGENT_USER" || die "Agent 계정 이름이 올바르지 않습니다: $AGENT_USER"
[[ $AGENT_USER != "$(id -un)" ]] || die 'Runner 계정 자신은 지우지 않습니다.'
valid_path "$AGENT_ROOT" || die "작업 영역 경로가 올바르지 않습니다: $AGENT_ROOT"
[[ $AGENT_ROOT != / && $AGENT_ROOT != "$HOME" && $AGENT_ROOT != "$HOME"/* ]] || die "이 경로는 지우지 않습니다: $AGENT_ROOT"
HAS_USER=0
getent passwd "$AGENT_USER" > /dev/null && HAS_USER=1
note "Agent 계정 $AGENT_USER: $([[ $HAS_USER == 1 ]] && echo 있음 || echo 없음)"
note "작업 영역 $AGENT_ROOT: $([[ $PURGE == 1 ]] && echo 삭제 || echo 남김)"
((DRY_RUN)) && note 'dry-run: 아래 sudo 명령은 실행하지 않고 보여 주기만 합니다.'

step '1. Runner의 비밀번호 없는 실행 권한부터 회수'
# 먼저 지우는 이유: 정리하는 동안 Runner가 새 Agent 세션을 띄우지 못하게 한다.
as_root rm -f -- "$SUDOERS_PATH"                                           # sudoers 규칙 삭제
as_root rm -f -- "$EXEC_PATH"                                              # 실행 래퍼 삭제
as_root rm -f -- "$CONF_PATH"                                              # 래퍼 설정 삭제
[[ -d $CONF_DIR ]] && as_root rmdir --ignore-fail-on-non-empty -- "$CONF_DIR"   # 빈 설정 폴더 삭제

step '2. 남은 Agent 프로세스 종료'
if ((HAS_USER)); then
  as_root pkill -KILL -u "$AGENT_USER" || true                             # Agent 계정의 프로세스를 모두 강제 종료(없으면 그냥 지나감)
fi

step '3. WSL 보호 해제'
# 계정을 지우기 전에 한다. 계정이 없어지면 이름으로 권한 항목을 지울 수 없다.
if [[ -f $GUARD_PATH ]]; then
  as_root systemctl disable "$GUARD_UNIT"                                  # 부팅 때 실행 끄기
  as_root rm -f -- "$GUARD_PATH"                                           # 서비스 파일 삭제
  as_root systemctl daemon-reload                                          # 서비스 목록 다시 읽기
fi
if ((HAS_USER)) && command -v setfacl > /dev/null; then
  for dir in /mnt /Docker /run/WSL; do
    if [[ -d $dir ]]; then as_root setfacl -x "u:$AGENT_USER" "$dir" || true; fi   # 그 폴더의 Agent 차단 항목만 지움(없으면 지나감)
  done
fi

step '4. 작업 영역'
if [[ -d $AGENT_ROOT ]]; then
  if ((PURGE)); then
    as_root rm -rf --one-file-system -- "$AGENT_ROOT"                      # 작업 영역 전체 삭제(--purge-work)
  else
    as_root rm -rf -- "$AGENT_ROOT/runtime"                                # Agent용 node 복사본만 삭제
    as_root chgrp -R --no-dereference "$(id -gn)" -- "$AGENT_ROOT"         # 그룹을 Runner 그룹으로 돌림(Agent 그룹이 없어지므로)
    note "작업 영역은 남겼습니다. 다 지우려면 --purge-work로 다시 실행하세요."
  fi
fi

step "5. Agent 계정 $AGENT_USER 삭제"
if ((HAS_USER)); then
  as_root userdel --remove "$AGENT_USER"                                   # 계정과 홈(Claude·Codex 로그인 정보 포함) 삭제
  if getent group "$AGENT_USER" > /dev/null; then
    as_root groupdel "$AGENT_USER" || true                                 # 전용 그룹이 남았으면 삭제
  fi
else
  note '계정이 없어 건너뜀'
fi

step '끝'
note "Runner 환경 파일(agent-runner/.env)의 AWBS_AGENT_USER·AWBS_AGENT_ROOT·AWBS_AGENT_EXEC 줄도 지우세요."
note '지우면 Runner는 다시 「격리 미정」으로 돌아가 실제 Agent 실행 계획을 만들지 않습니다.'
((DRY_RUN)) && printf '\n(dry-run이라 아무것도 바꾸지 않았습니다.)\n'
exit 0
