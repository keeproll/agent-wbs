#!/usr/bin/env bash
# Agent 전용 OS 계정 되돌리기(setup-agent-user.sh의 반대). owner가 Runner 계정으로 실행한다.
#
#   bash agent-runner/scripts/isolation/remove-agent-user.sh --dry-run        # 무엇을 지울지 보기만
#   bash agent-runner/scripts/isolation/remove-agent-user.sh                  # 계정·래퍼·규칙 제거(작업 영역은 남김)
#   bash agent-runner/scripts/isolation/remove-agent-user.sh --purge-work     # 작업 영역(/srv/agentwbs)까지 삭제
#
# 옵션
#   --dry-run       관리자 명령을 실행하지 않고 보여 주기만 한다.
#   --purge-work    작업 영역 전체(작업 폴더·입력 사본·CLI 설치본)도 지운다. 기본은 남긴다.
#
# 계정 이름(awbs-agent)과 경로(/srv/agentwbs)는 고정이다. 옵션으로 바꾸지 못한다.
# 실행 전에 Runner를 멈추세요. 실행 중인 Agent 세션은 이 스크립트가 강제로 끝냅니다.
#
# 순서(왜 이 순서인가): ① 실행 규칙을 지워 새 Agent가 못 뜨게 닫는다 → ② Agent 프로세스를 끝내고 0개인지 확인 →
#   ③ 계정 삭제 → ④ 그 뒤에야 Windows 차단을 푼다 → ⑤ 남은 숫자 권한 항목·소유권 정리.
#   중간에 실패하면 Windows 차단은 걸린 그대로 남는다. 고친 뒤 같은 명령을 다시 실행하면 이어서 정리한다(리뷰 P2-4·P2-9).
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
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "모르는 옵션입니다: $1 (계정 이름·경로는 고정이라 옵션이 없습니다)" 2 ;;
  esac
done

step '0. 사전 확인(관리자 권한 필요 없음)'
[[ -n $ROOT_PREFIX ]] && note "시험 모드: 가짜 루트 $ROOT_PREFIX (실제 관리자 명령 없음)"
RUNNER_USER=$(id -un)
[[ $(id -u) != 0 && $RUNNER_USER != root ]] || die 'root가 아니라 Runner 계정으로 실행하세요.'
[[ $RUNNER_USER != "$AGENT_USER" ]] || die 'Agent 계정으로는 실행하지 않습니다.'
RUNNER_HOME=$(realpath -e -- "$HOME") || die "Runner 홈이 없습니다: $HOME"

# 지울 대상의 UID: 계정이 있으면 이 설치가 만든 계정인지 확인한 UID, 없으면 설치 기록의 UID.
# 왜 기록을 쓰나: 계정을 먼저 지운 뒤 실패했다가 다시 실행해도, 숫자로 남은 권한 항목을 회수해야 한다(리뷰 P2-9).
ACCOUNT=$(agent_account_state)
UID_NUM=''
[[ -f $UID_RECORD ]] && UID_NUM=$(< "$UID_RECORD")
[[ -z $UID_NUM || $UID_NUM =~ ^[0-9]+$ ]] || die "설치 기록의 UID 형식이 아닙니다: $UID_RECORD"
if [[ -n $UID_NUM ]] && ((UID_NUM <= 0 || UID_NUM >= 1000)); then die "설치 기록의 UID가 시스템 계정 범위가 아닙니다: $UID_NUM"; fi
case $ACCOUNT in
  ours) ;;
  none) note '계정은 이미 없음' ;;
  *) die "$AGENT_USER 계정이 이 설치가 만든 전용 계정이 아닙니다(UID 기록·홈·셸·그룹 불일치). 손대지 않고 멈춥니다." ;;
esac
if [[ -z $UID_NUM ]]; then
  [[ $ACCOUNT == none ]] || die '계정은 있는데 설치 기록이 없습니다. 손대지 않고 멈춥니다.'
  note '설치 기록도 없음: 남은 Agent 권한 항목이 없다고 봅니다.'
fi

# root가 다룰 고정 경로를 먼저 검사한다(링크·예상 밖 소유자면 멈춤).
for p in "$SUDOERS_PATH" "$EXEC_PATH" "$CONF_PATH" "$GUARD_PATH"; do
  safe_fixed_path "$p"
done
safe_fixed_path "$AGENT_ROOT" "$RUNNER_USER"
for p in "${WSL_BLOCK_DIRS[@]}"; do
  [[ -e $p || -L $p ]] && safe_fixed_path "$p"
done
# 작업 영역 실제 경로가 고정 경로와 같은지 본다(정규화 뒤 비교, 리뷰 P2-3).
if [[ -e $AGENT_ROOT ]]; then
  real_root=$(realpath -e -- "$AGENT_ROOT")
  [[ $real_root == "$AGENT_ROOT" ]] || die "작업 영역 실제 경로가 고정 경로와 다릅니다: $real_root"
  [[ $real_root != "$RUNNER_HOME" && $real_root != "$RUNNER_HOME"/* && $RUNNER_HOME != "$real_root"/* ]] || die '작업 영역이 Runner 홈과 겹칩니다.'
fi
note "Agent 계정 $AGENT_USER: $ACCOUNT, 기록 UID: ${UID_NUM:-없음}"
note "작업 영역 $AGENT_ROOT: $([[ $PURGE == 1 ]] && echo 삭제 || echo 남김)"
((DRY_RUN)) && note 'dry-run: 아래 sudo 명령은 실행하지 않고 보여 주기만 합니다.'

FINISHED=0
# shellcheck disable=SC2317  # trap으로 불린다.
on_exit() {
  local rc=$?
  if ((rc != 0 && !DRY_RUN && !FINISHED)); then
    printf '\n되돌리기가 중간에 멈췄습니다(종료 코드 %s). 실행 규칙은 지웠고 Windows 차단은 그대로 둡니다.\n' "$rc" >&2
    printf '원인을 고친 뒤 같은 명령을 다시 실행하세요. 남은 단계부터 이어서 정리합니다.\n' >&2
  fi
}
trap on_exit EXIT

step '1. Runner의 비밀번호 없는 실행 권한부터 회수(새 Agent 세션이 뜨지 못하게)'
as_root rm -f -- "$SUDOERS_PATH"                                           # sudoers 규칙 삭제
as_root rm -f -- "$EXEC_PATH"                                              # 실행 래퍼 삭제
as_root rm -f -- "$CONF_PATH"                                              # 래퍼 설정 삭제(UID 기록은 마지막까지 남김)

step '2. 남은 Agent 프로세스 종료와 확인'
if [[ -n $UID_NUM ]]; then
  if ((DRY_RUN)); then
    as_root pkill -KILL -U "$UID_NUM"
    as_root pgrep -U "$UID_NUM"
  else
    # pkill·pgrep 종료 코드: 0 = 찾음, 1 = 없음, 그 밖 = 오류. 오류는 「없음」으로 치지 않는다.
    gone=0
    for _ in 1 2 3 4 5; do
      rc=0; sudo -- pkill -KILL -U "$UID_NUM" || rc=$?
      ((rc <= 1)) || die "Agent 프로세스 종료 명령이 실패했습니다(pkill 종료 코드 $rc)."
      rc=0; sudo -- pgrep -U "$UID_NUM" > /dev/null || rc=$?
      if ((rc == 1)); then gone=1; break; fi
      ((rc == 0)) || die "Agent 프로세스 확인 명령이 실패했습니다(pgrep 종료 코드 $rc)."
      sleep 1
    done
    ((gone)) || die 'Agent 프로세스가 아직 남아 있습니다. Windows 차단을 유지한 채 멈춥니다.'
    note 'Agent 프로세스 0개 확인'
  fi
fi

step "3. Agent 계정 $AGENT_USER 삭제"
if [[ $ACCOUNT == ours ]]; then
  as_root userdel --remove "$AGENT_USER"                                   # 계정과 홈(Claude·Codex 로그인 정보 포함) 삭제
  if ((!DRY_RUN)) && getent group "$AGENT_USER" > /dev/null; then
    as_root groupdel "$AGENT_USER"                                         # 전용 그룹이 남았으면 삭제
  fi
else
  note '계정이 없어 건너뜀'
fi

step '4. WSL 보호 해제(프로세스 0개와 계정 삭제를 확인한 뒤에만)'
if [[ -f $GUARD_PATH ]]; then
  as_root systemctl disable "$GUARD_UNIT"                                  # 부팅 때 실행 끄기
  as_root rm -f -- "$GUARD_PATH"                                           # 서비스 파일 삭제
  as_root systemctl daemon-reload                                          # 서비스 목록 다시 읽기
fi
if [[ -n $UID_NUM ]]; then
  for dir in "${WSL_BLOCK_DIRS[@]}"; do
    [[ -d $dir ]] || continue
    as_root setfacl -P -x "u:$UID_NUM" "$dir"                              # 숫자 UID로 지움(계정 이름은 이미 없음). -P: 링크는 따라가지 않음
  done
fi

step '5. 작업 영역'
if [[ -d $AGENT_ROOT ]]; then
  if ((PURGE)); then
    as_root rm -rf --one-file-system -- "$AGENT_ROOT"                      # 작업 영역 전체 삭제(--purge-work). rm은 링크 안을 따라가지 않는다
  else
    as_root rm -rf -- "$AGENT_ROOT/runtime"                                # Agent용 node 복사본만 삭제
    # 남길 파일에서 Agent 흔적을 남김없이 지운다. 나중에 같은 숫자 UID가 다른 계정에 배정돼도 접근하지 못하게(리뷰 P2-9).
    as_root setfacl -R -P -b -- "$AGENT_ROOT"                              # 이름·숫자 권한 항목과 기본 ACL 모두 삭제(링크는 따라가지 않음)
    if [[ -n $UID_NUM ]]; then
      as_root chown -R --no-dereference --from="$UID_NUM" "$RUNNER_USER" -- "$AGENT_ROOT"   # Agent가 소유했던 파일은 Runner 소유로
    fi
    as_root chgrp -R --no-dereference "$(id -gn)" -- "$AGENT_ROOT"         # 그룹을 Runner 그룹으로(Agent 그룹은 없어짐)
    note "작업 영역은 남겼습니다. 다 지우려면 --purge-work로 다시 실행하세요."
  fi
fi

step '6. 설치 기록 삭제(모든 정리가 끝난 뒤)'
as_root rm -f -- "$UID_RECORD"
[[ -d $CONF_DIR ]] && as_root rmdir --ignore-fail-on-non-empty -- "$CONF_DIR"
FINISHED=1

step '끝'
note "Runner 환경 파일(agent-runner/.env)의 AWBS_AGENT_USER 줄도 지우세요."
note '지우면 Runner는 다시 「격리 미정」으로 돌아가 실제 Agent 실행 계획을 만들지 않습니다.'
((DRY_RUN)) && printf '\n(dry-run이라 아무것도 바꾸지 않았습니다.)\n'
exit 0
