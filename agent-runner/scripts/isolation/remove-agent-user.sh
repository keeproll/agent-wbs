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
MARKER=''
[[ -f $UID_RECORD ]] && UID_NUM=$(< "$UID_RECORD")
[[ -z $UID_NUM || $UID_NUM =~ ^[0-9]+$ ]] || die "설치 기록의 UID 형식이 아닙니다: $UID_RECORD"
case $ACCOUNT in
  ours) MARKER=$(agent_entry_field 5); MARKER=${MARKER#"Agent WBS agent "} ;;
  marked)
    # UID 기록 없이 생성 표식만 있는 우리 계정(설치가 계정을 만든 직후 끊긴 경우 등). 계정의 UID로 정리한다(리뷰2 P2-B).
    [[ -z $UID_NUM ]] || die 'UID 기록과 계정이 맞지 않습니다.'
    UID_NUM=$(agent_entry_field 3)
    MARKER=$(agent_entry_field 5); MARKER=${MARKER#"Agent WBS agent "}
    note "UID 기록은 없지만 생성 표식이 있는 우리 계정(UID $UID_NUM)" ;;
  none)
    note '계정은 이미 없음'
    # 계정은 없고 진행 기록만 있으면 그 UID로 남은 권한 항목을 정리한다(단계마다 그 UID를 다시 확인한다).
    if [[ -z $UID_NUM && -f $PENDING_RECORD ]]; then
      read -r p_name p_uid p_marker < "$PENDING_RECORD" || true
      [[ $p_name == "$AGENT_USER" && $p_uid =~ ^[0-9]+$ && $p_marker =~ ^awbs-agent-setup-[0-9a-f]{16}$ ]] || die "진행 기록 형식이 올바르지 않습니다: $PENDING_RECORD"
      UID_NUM=$p_uid
      MARKER=$p_marker
    fi ;;
  *) die "$AGENT_USER 계정이 이 설치가 만든 전용 계정이 아닙니다(UID 기록·홈·셸·그룹·생성 표식 불일치). 손대지 않고 멈춥니다." ;;
esac
# 어디서 얻은 UID든 마지막에 같은 범위 검사를 한다(리뷰3 P2: 진행 기록의 0 같은 값도 거부).
if [[ -n $UID_NUM ]] && ((UID_NUM <= 0 || UID_NUM >= 1000)); then die "기록된 UID가 시스템 계정 범위(1~999)가 아닙니다: $UID_NUM"; fi
if [[ -z $UID_NUM ]]; then
  [[ $ACCOUNT == none ]] || die '계정은 있는데 설치 기록이 없습니다. 손대지 않고 멈춥니다.'
  note '설치 기록도 없음: 남은 Agent 권한 항목이 없다고 봅니다.'
fi
# 끝내지 못한 항목. 하나라도 있으면 기록을 지우지 않고 목록을 보여 준 뒤 종료 코드 3으로 끝난다(리뷰3 P3).
LEFT=()
left() { LEFT+=("$1"); printf '   건너뜀: %s\n' "$1"; }
# UID 단계 앞의 공통 확인 문구
uid_owner() { getent passwd "$1" | cut -d: -f1 || true; }

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
    if ((${#LEFT[@]})); then
      printf '남은 항목:\n' >&2
      printf '  - %s\n' "${LEFT[@]}" >&2
    fi
  fi
}
trap on_exit EXIT

step '1. Runner의 비밀번호 없는 실행 권한부터 회수(새 Agent 세션이 뜨지 못하게)'
as_root rm -f -- "$SUDOERS_PATH"                                           # sudoers 규칙 삭제
as_root rm -f -- "$EXEC_PATH"                                              # 실행 래퍼 삭제
as_root rm -f -- "$CONF_PATH"                                              # 래퍼 설정 삭제(UID 기록은 마지막까지 남김)

step '2. 남은 Agent 프로세스 종료와 확인'
# 종료는 「그 UID가 지금도 우리 Agent 계정」일 때만 한다. 계정이 이미 없으면 UID로 종료하지 않는다(리뷰3 P2).
PROCS_GONE=0
if [[ -z $UID_NUM ]]; then
  PROCS_GONE=1
elif ((DRY_RUN)); then
  note "(실제 실행에서는 명령마다 UID $UID_NUM이 지금도 $AGENT_USER·생성 표식인지 먼저 확인한다)"
  if [[ $ACCOUNT != none ]]; then as_root pkill -KILL -U "$UID_NUM"; fi
  as_root pgrep -U "$UID_NUM"
  PROCS_GONE=1
elif [[ $ACCOUNT == none ]]; then
  if uid_is_unassigned "$UID_NUM"; then
    # 아무 계정도 쓰지 않는 번호다. 종료는 하지 않고 남은 프로세스가 있는지만 본다(읽기만).
    rc=0; sudo -- pgrep -U "$UID_NUM" > /dev/null || rc=$?
    case $rc in
      1) PROCS_GONE=1; note "UID $UID_NUM 프로세스 없음 확인(계정이 없어 종료는 하지 않음)" ;;
      0) left "UID $UID_NUM 프로세스가 남아 있음(계정이 없어 종료하지 않음). 직접 확인 필요" ;;
      *) left "UID $UID_NUM 프로세스 확인 실패(pgrep 종료 코드 $rc)" ;;
    esac
  else
    left "UID $UID_NUM은 지금 다른 계정($(uid_owner "$UID_NUM"))이 씀: 프로세스 확인·종료 건너뜀"
  fi
else
  # pkill·pgrep 종료 코드: 0 = 찾음, 1 = 없음, 그 밖 = 오류. 오류는 「없음」으로 치지 않는다.
  for _ in 1 2 3 4 5; do
    if ! uid_is_agent "$UID_NUM" "$MARKER"; then
      left "UID $UID_NUM이 지금 $AGENT_USER·생성 표식과 다름($(uid_owner "$UID_NUM")): 프로세스 종료 건너뜀"
      break
    fi
    rc=0; sudo -- pkill -KILL -U "$UID_NUM" || rc=$?
    ((rc <= 1)) || die "Agent 프로세스 종료 명령이 실패했습니다(pkill 종료 코드 $rc)."
    rc=0; sudo -- pgrep -U "$UID_NUM" > /dev/null || rc=$?
    if ((rc == 1)); then PROCS_GONE=1; break; fi
    ((rc == 0)) || die "Agent 프로세스 확인 명령이 실패했습니다(pgrep 종료 코드 $rc)."
    sleep 1
  done
  if ((PROCS_GONE)); then note 'Agent 프로세스 0개 확인'; elif ((${#LEFT[@]} == 0)); then die 'Agent 프로세스가 아직 남아 있습니다. Windows 차단을 유지한 채 멈춥니다.'; fi
fi

step "3. Agent 계정 $AGENT_USER 삭제"
ACCOUNT_GONE=0
if [[ $ACCOUNT == none ]]; then
  ACCOUNT_GONE=1
  note '계정이 없어 건너뜀'
elif ((!PROCS_GONE)); then
  left "Agent 프로세스 0개를 확인하지 못해 계정 삭제 건너뜀"
elif ((!DRY_RUN)) && ! uid_is_agent "$UID_NUM" "$MARKER"; then
  left "UID $UID_NUM이 지금 $AGENT_USER·생성 표식과 다름: 계정 삭제 건너뜀"
else
  as_root userdel --remove "$AGENT_USER"                                   # 계정과 홈(Claude·Codex 로그인 정보 포함) 삭제
  if ((!DRY_RUN)) && [[ $(getent group "$AGENT_USER" | cut -d: -f3 || true) == "$UID_NUM" ]]; then
    as_root groupdel "$AGENT_USER"                                         # 같은 번호의 전용 그룹이 남았으면 삭제
  fi
  ACCOUNT_GONE=1
fi

step '4. WSL 보호 해제(프로세스 0개와 계정 삭제를 확인한 뒤에만)'
if ((!PROCS_GONE || !ACCOUNT_GONE)); then
  left 'Windows 차단 해제 건너뜀(프로세스 0개·계정 삭제를 확인하지 못함). 차단은 걸린 그대로'
else
  if [[ -f $GUARD_PATH ]]; then
    as_root systemctl disable "$GUARD_UNIT"                                # 부팅 때 실행 끄기
    as_root rm -f -- "$GUARD_PATH"                                         # 서비스 파일 삭제
    as_root systemctl daemon-reload                                        # 서비스 목록 다시 읽기
  fi
  if [[ -n $UID_NUM ]]; then
    for dir in "${WSL_BLOCK_DIRS[@]}"; do
      [[ -d $dir ]] || continue
      # 숫자 UID 항목을 지우기 직전마다, 그 번호를 지금 아무 계정도 쓰지 않는지 본다(다른 계정의 권한 항목을 지우지 않게).
      if ((!DRY_RUN)) && ! uid_is_unassigned "$UID_NUM"; then
        left "UID $UID_NUM을 지금 다른 계정($(uid_owner "$UID_NUM"))이 씀: $dir 권한 항목 삭제 건너뜀"
        continue
      fi
      as_root setfacl -P -x "u:$UID_NUM" "$dir"                            # 숫자 UID로 지움. -P: 링크는 따라가지 않음
    done
  fi
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
      if ((!DRY_RUN)) && ! uid_is_unassigned "$UID_NUM"; then
        left "UID $UID_NUM이 아직 있거나 다른 계정($(uid_owner "$UID_NUM"))이 씀: 소유권 정리(chown --from) 건너뜀"
      else
        as_root chown -R --no-dereference --from="$UID_NUM" "$RUNNER_USER" -- "$AGENT_ROOT"   # Agent가 소유했던 파일은 Runner 소유로
      fi
    fi
    as_root chgrp -R --no-dereference "$(id -gn)" -- "$AGENT_ROOT"         # 그룹을 Runner 그룹으로(Agent 그룹은 없어짐)
    note "작업 영역은 남겼습니다. 다 지우려면 --purge-work로 다시 실행하세요."
  fi
fi

step '6. 설치 기록 삭제(모든 정리가 끝난 뒤)'
if ((${#LEFT[@]})); then
  # 끝내지 못한 항목이 있으면 기록을 남긴다. 다시 실행할 때 같은 UID로 이어서 확인·정리한다.
  printf '\n되돌리기를 끝내지 못했습니다. 기록(%s)은 남겨 둡니다. 남은 항목:\n' "$CONF_DIR" >&2
  printf '  - %s\n' "${LEFT[@]}" >&2
  FINISHED=1
  exit 3
fi
as_root rm -f -- "$UID_RECORD"
as_root rm -f -- "$PENDING_RECORD"
[[ -d $CONF_DIR ]] && as_root rmdir --ignore-fail-on-non-empty -- "$CONF_DIR"
FINISHED=1

step '끝'
note "Runner 환경 파일(agent-runner/.env)의 AWBS_AGENT_USER 줄도 지우세요."
note '지우면 Runner는 다시 「격리 미정」으로 돌아가 실제 Agent 실행 계획을 만들지 않습니다.'
((DRY_RUN)) && printf '\n(dry-run이라 아무것도 바꾸지 않았습니다.)\n'
exit 0
