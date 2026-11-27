#!/usr/bin/env bash
# Agent 전용 OS 계정 설치(Q-08). owner가 Runner 계정(keeproll)으로 한 번 실행한다.
#
#   bash agent-runner/scripts/isolation/setup-agent-user.sh --dry-run   # 무엇을 할지 보기만(sudo 안 씀)
#   bash agent-runner/scripts/isolation/setup-agent-user.sh             # 실제 설치(중간에 sudo 비밀번호를 물음)
#
# 옵션
#   --dry-run       관리자 명령을 실행하지 않고 보여 주기만 한다. 만들 파일 내용도 보여 준다.
#   --node 경로      Agent가 쓸 node 실행 파일(기본: 지금 PATH의 node)
#
# 계정 이름(awbs-agent)과 경로(/srv/agentwbs 등)는 고정이다. 옵션으로 바꾸지 못한다.
# 이 스크립트 자신은 sudo로 부르지 않는다. 관리자 권한이 필요한 줄만 안에서 sudo로 실행한다.
# 왜: Runner 계정 이름·홈·node 위치를 「지금 사용자」에게서 읽어야 하기 때문이다(sudo 안에서는 root가 된다).
# 다시 실행해도 된다. 이미 있는 계정이 이 설치가 만든 계정일 때만 그대로 두고 권한·파일을 다시 맞춘다.
#
# 순서(왜 이 순서인가): ① 비밀번호 없는 실행 규칙을 먼저 지워 「닫고」 시작한다 → ② 계정 → ③ Windows 차단 →
#   ④ 작업 영역·래퍼 → ⑤ 래퍼 점검이 ok인지 확인 → ⑥ 마지막에 실행 규칙을 넣는다.
#   중간에 실패하면 실행 규칙이 없는 상태(닫힘)로 끝나고, Windows 차단은 걸린 그대로 둔다(리뷰 P2-4).
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
    --node) (($# >= 2)) || die '--node에 경로가 필요합니다.' 2; NODE_BIN=$2; shift 2 ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "모르는 옵션입니다: $1 (계정 이름·경로는 고정이라 옵션이 없습니다)" 2 ;;
  esac
done

# ---------------------------------------------------------------- 0. 사전 확인(관리자 권한 없음)
step '0. 사전 확인(관리자 권한 필요 없음)'
[[ -n $ROOT_PREFIX ]] && note "시험 모드: 가짜 루트 $ROOT_PREFIX (실제 관리자 명령 없음)"
RUNNER_USER=$(id -un)
# Runner 계정으로 실행해야 한다. root로 실행하면 Runner 계정 이름을 root로 잘못 적는다.
[[ $(id -u) != 0 && $RUNNER_USER != root ]] || die 'root가 아니라 Runner 계정(예: keeproll)으로 실행하세요. sudo bash ... 로 부르지 마세요.'
valid_user "$RUNNER_USER" || die "Runner 계정 이름이 올바르지 않습니다: $RUNNER_USER"
[[ $RUNNER_USER != "$AGENT_USER" ]] || die 'Agent 계정으로는 실행하지 않습니다.'
# 홈 경로는 링크를 따라간 실제 경로로 바꾼 뒤 비교한다(리뷰 P2-3: /home//keeproll 같은 다른 표기).
RUNNER_HOME=$(realpath -e -- "$HOME") || die "Runner 홈이 없습니다: $HOME"
valid_path "$RUNNER_HOME" || die "Runner 홈 경로가 올바르지 않습니다: $RUNNER_HOME"
[[ $AGENT_ROOT != "$RUNNER_HOME" && $AGENT_ROOT != "$RUNNER_HOME"/* ]] || die '작업 영역은 Runner 홈 밖이어야 합니다.'
[[ -n $NODE_BIN ]] || NODE_BIN=$(command -v node || true)
[[ -n $NODE_BIN ]] || die 'node를 찾지 못했습니다. --node 경로를 주세요.'
NODE_BIN=$(realpath -e -- "$NODE_BIN") || die "node 파일이 없습니다: $NODE_BIN"
[[ -f $NODE_BIN && -x $NODE_BIN ]] || die "node가 실행 파일이 아닙니다: $NODE_BIN"
command -v sudo > /dev/null || die 'sudo가 없습니다.'
[[ -f $HERE/awbs-agent-exec.sh ]] || die '실행 래퍼(awbs-agent-exec.sh)가 같은 폴더에 없습니다.'
[[ -f $HERE/awbs-resolv-sync.sh ]] || die 'DNS 도우미(awbs-resolv-sync.sh)가 같은 폴더에 없습니다.'
IS_WSL=0
[[ -e $WSL_BINFMT || -d $ROOT_PREFIX/run/WSL ]] && IS_WSL=1

# Agent DNS 방식 고르기(fix8). 아무것도 바꾸기 전에 정한다(dry-run에서도 보이게).
#   tunnel: DNS 원본의 nameserver가 DNS 터널링 고정 주소(10.255.255.254) 하나뿐 → wsl.conf + 실제 파일(기본)
#   sync:   그 밖의 주소 → fix7 도우미 + 감시 + 타이머(대체, 크게 알림)
#   manual: /etc/resolv.conf가 owner가 직접 관리하는 실제 파일 → 건드리지 않음
DNS_MODE='' DNS_BASE=''
if ((IS_WSL)); then
  if [[ -f $RESOLV_SRC && ! -L $RESOLV_SRC ]] && [[ $(owner_of "$RESOLV_SRC") == root ]]; then
    DNS_BASE=$RESOLV_SRC
  elif resolv_is_ours; then
    DNS_BASE=$RESOLV_DST          # 이미 터널링 방식으로 바꾼 뒤다(WSL이 원본을 더 만들지 않을 수 있다).
  fi
  if [[ -f $RESOLV_DST && ! -L $RESOLV_DST ]] && ! resolv_is_ours; then
    DNS_MODE=manual               # owner가 직접 관리하는 실제 파일(예: 이미 generateResolvConf = false로 손수 설정)
  elif [[ -n $DNS_BASE ]] && resolv_is_tunnel "$DNS_BASE"; then
    DNS_MODE=tunnel
  elif [[ -n $DNS_BASE && $DNS_BASE == "$RESOLV_SRC" ]]; then
    DNS_MODE=sync
  else
    die "WSL DNS 설정을 찾지 못했습니다($RESOLV_SRC 없음). WSL을 다시 시작한 뒤 다시 실행하세요."
  fi
fi

# 계정: 없으면 새로 만들고, 있으면 이 설치가 만든 계정인지 확인한다. 다른 계정이면 손대지 않는다.
ACCOUNT=$(agent_account_state)
# 진행 기록이 남아 있으면 지난 설치가 계정을 만드는 도중 끊긴 것이다(강제 종료 등으로 정리 코드도 못 돈 경우).
# 계정이 없으면 기록만, 계정이 기록(이름·UID·표식)과 같으면 그 계정까지 아래 정리 단계에서 되돌린 뒤 새로 만든다.
RESUME=''
if [[ -f $PENDING_RECORD ]]; then
  if [[ $ACCOUNT == ours ]]; then RESUME=finish; else RESUME=rollback; fi
fi
case $ACCOUNT in
  none) [[ ! -e $UID_RECORD ]] || die "계정은 없는데 설치 기록($UID_RECORD)이 남아 있습니다. remove-agent-user.sh로 먼저 정리하세요." ;;
  ours) ;;
  marked) [[ $RESUME == rollback ]] || die "$AGENT_USER 계정에 생성 표식은 있지만 UID 기록이 없습니다. remove-agent-user.sh로 먼저 정리하세요." ;;
  *) die "$AGENT_USER 계정이 이미 있지만 이 설치가 만든 전용 계정이 아닙니다(UID 기록·홈·셸·그룹 불일치). 손대지 않고 멈춥니다." ;;
esac

# root가 다룰 고정 경로를 모두 먼저 검사한다. 링크나 예상 밖 소유자가 하나라도 있으면 아무것도 하지 않고 멈춘다.
for p in "$CONF_DIR" "$(dirname "$EXEC_PATH")" "$(dirname "$SUDOERS_PATH")" "$(dirname "$GUARD_PATH")" "$AGENT_ROOT/runtime/node/bin"; do
  safe_fixed_path "$p" "$RUNNER_USER"
done
for p in "$AGENT_ROOT/cli" "$AGENT_ROOT/inputs" "$AGENT_ROOT/worktrees"; do
  safe_fixed_path "$p" "$RUNNER_USER"
done
for p in "${WSL_BLOCK_DIRS[@]}"; do
  [[ -e $p || -L $p ]] && safe_fixed_path "$p"
done
for p in "$CRON_DENY" "$AT_DENY" "$RESOLV_SYNC_PATH" "$RESOLV_UNIT_PATH" "$RESOLV_WATCH_PATH" "$RESOLV_TIMER_PATH" "$WSL_CONF"; do
  safe_fixed_path "$p"
done
# cron.allow·at.allow가 있으면 deny 파일은 쓰이지 않는다(allow에 없는 계정만 막힘). 그 경우 allow에 Agent가 없어야 한다.
for p in "$CRON_ALLOW" "$AT_ALLOW"; do
  if [[ -e $p ]]; then
    safe_fixed_path "$p"
    rc=0; deny_has_agent "$p" || rc=$?
    ((rc != 0)) || die "$p에 $AGENT_USER가 있어 예약 실행을 막을 수 없습니다. 그 줄을 지운 뒤 다시 실행하세요."
    if ((rc == 2 && DRY_RUN)); then note "$p: 관리자 권한 없이는 못 읽음(실제 설치 때 sudo로 확인)"; continue; fi
    ((rc != 2)) || die "$p를 읽지 못했습니다."
  fi
done

note "Runner 계정: $RUNNER_USER (홈 $RUNNER_HOME)"
note "Agent 계정: $AGENT_USER (홈 $AGENT_HOME, 상태: $ACCOUNT)"
note "Agent 작업 영역: $AGENT_ROOT"
note "Agent용 node: $NODE_BIN ($("$NODE_BIN" --version))"
note "WSL 여부: $([[ $IS_WSL == 1 ]] && echo 예 || echo 아니오)"
case $DNS_MODE in
  tunnel) note "Agent DNS 방식: 터널링(nameserver $DNS_TUNNEL_NS 고정) → /etc/wsl.conf generateResolvConf = false + /etc/resolv.conf 실제 파일" ;;
  sync) note "Agent DNS 방식: 대체(nameserver가 $DNS_TUNNEL_NS 하나가 아님) → 도우미 + 감시 + 타이머" ;;
  manual) note 'Agent DNS 방식: /etc/resolv.conf를 직접 관리하는 파일로 보고 건드리지 않음' ;;
esac
((DRY_RUN)) && note 'dry-run: 아래 sudo 명령은 실행하지 않고 보여 주기만 합니다.'

# 여기부터는 현재 폴더를 루트(/)로 둔다. 아래 sudo -u awbs-agent 명령은 현재 폴더를 물려받는데,
# owner가 홈(/home/keeproll)에서 실행하면 Agent가 들어갈 수 없는 폴더에서 명령이 돌아 실패할 수 있다.
# 상대 경로(--node ./node 등)는 위에서 이미 절대 경로로 바꿨으므로 옮겨도 된다.
cd / || die '루트 폴더(/)로 옮기지 못했습니다.'

# 설치할 파일 내용은 먼저 Runner 계정의 임시 폴더(0700)에 만들고, 확인한 뒤 root 소유로 옮긴다.
TMP=$(mktemp -d)
FINISHED=0
CREATING=0
# shellcheck disable=SC2317,SC2329  # trap으로 불린다(shellcheck 0.10은 SC2317, 0.11은 SC2329로 알림. 리뷰7 P3-6).
on_exit() {
  local rc=$?
  rm -rf -- "$TMP"
  if ((rc != 0 && !DRY_RUN && !FINISHED)); then
    # 실패하면 「닫힌」 쪽으로: 비밀번호 없는 실행 규칙을 지운다. Windows 차단 ACL은 지우지 않고 그대로 둔다.
    printf '\n설치가 중간에 멈췄습니다(종료 코드 %s). 비밀번호 없는 실행 규칙을 지우고 닫힌 상태로 둡니다.\n' "$rc" >&2
    # 계정을 만들던 중이면 진행 기록으로 그 계정만 되돌린다(이름·UID·생성 표식이 모두 맞을 때만).
    if ((CREATING)); then
      if rollback_pending; then
        printf '이번 설치가 만든 계정과 진행 기록을 되돌렸습니다. 원인을 고친 뒤 같은 명령을 다시 실행하세요.\n' >&2
      else
        printf '계정을 되돌리지 못했습니다. 진행 기록(%s)을 남겨 둡니다. 다시 실행하면 이어서 정리합니다.\n' "$PENDING_RECORD" >&2
      fi
    fi
    sudo -- rm -f -- "$SUDOERS_PATH" || printf '경고: %s를 지우지 못했습니다. 직접 지우세요.\n' "$SUDOERS_PATH" >&2
  fi
}
trap on_exit EXIT

cat > "$TMP/agent-exec.conf" << EOF
# Agent WBS 실행 래퍼 설정(setup-agent-user.sh가 만듦). 래퍼는 이 이름들만 읽는다.
AGENT_USER=$AGENT_USER
RUNNER_USER=$RUNNER_USER
RUNNER_HOME=$RUNNER_HOME
AGENT_ROOT=$AGENT_ROOT
NODE_DIR=$AGENT_ROOT/runtime/node/bin
EOF

sudoers_content "$RUNNER_USER" > "$TMP/sudoers"

cat > "$TMP/guard.service" << EOF
# Agent WBS(Q-08): 부팅마다 Agent 계정이 WSL의 Windows 실행 통로(/run/WSL)에 들어가지 못하게 막는다.
# /run은 부팅 때마다 새로 만들어지므로 권한 설정도 부팅마다 다시 해야 한다.
# -P: 링크면 따라가지 않고 건너뛴다.
[Unit]
Description=Agent WBS: block $AGENT_USER from WSL interop sockets
After=local-fs.target
ConditionPathExists=/run/WSL

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/setfacl -P -m u:$AGENT_USER:--- /run/WSL

[Install]
WantedBy=multi-user.target
EOF

# sudoers 문법을 미리 검사한다. 문법이 틀린 파일을 넣으면 sudo 전체가 멈출 수 있기 때문이다.
if /usr/sbin/visudo -c -q -f "$TMP/sudoers" > /dev/null 2>&1; then
  note 'sudoers 문법 검사(미리 보기): 통과'
else
  note 'sudoers 문법 검사(미리 보기): 관리자 권한 없이는 확인하지 못함. 마지막 단계에서 sudo로 다시 검사한다.'
fi

if ((DRY_RUN)); then
  for f in agent-exec.conf sudoers guard.service; do
    printf '\n--- 만들 파일: %s\n' "$f"
    cat "$TMP/$f"
  done
fi

# ---------------------------------------------------------------- DNS 방식별 할 일(4-1단계에서 부름)
# 기본(터널링): WSL이 /etc/resolv.conf를 링크로 다시 만들지 않게 하고(wsl.conf), 그 내용의 실제 파일을 둔다.
# 왜: WSL은 wsl.exe를 실행할 때마다 링크를 다시 만든다(0.4초에 3번). 감시로 따라가면 놓치거나 멈춘다(리뷰7 P2-1).
#     DNS 터널링 주소는 10.255.255.254로 고정이라 실제 파일로 둬도 낡지 않는다.
dns_tunnel() {
  note "DNS 터널링(nameserver $DNS_TUNNEL_NS 고정)이라 WSL의 자동 생성을 끄고 실제 파일로 둔다."
  # 대체 방식(fix7 도우미·감시·타이머)이 남아 있으면 먼저 끈다. 켜 둔 채면 서로 다른 내용으로 바꿀 수 있다.
  remove_resolv_sync
  # wsl.conf: 설치 전 모습을 한 번만 보관한다(다시 실행해도 처음 보관한 것을 덮어쓰지 않는다).
  if [[ ! -e $WSL_CONF_BACKUP && ! -e $WSL_CONF_ABSENT ]]; then
    if [[ -e $WSL_CONF ]]; then
      as_root install -o root -g root -m 0644 "$WSL_CONF" "$WSL_CONF_BACKUP"          # 설치 전 /etc/wsl.conf 보관(제거 때 되돌림)
    else
      : > "$TMP/wsl.conf.absent"
      as_root install -o root -g root -m 0644 "$TMP/wsl.conf.absent" "$WSL_CONF_ABSENT"  # 설치 전에는 없었다는 표시
    fi
  fi
  if [[ -f $WSL_CONF ]]; then wsl_conf_with_resolv_off < "$WSL_CONF" > "$TMP/wsl.conf"; else wsl_conf_with_resolv_off < /dev/null > "$TMP/wsl.conf"; fi
  if ((DRY_RUN)); then printf '\n--- 만들 파일: /etc/wsl.conf\n'; cat "$TMP/wsl.conf"; fi
  if [[ -f $WSL_CONF ]] && cmp -s -- "$TMP/wsl.conf" "$WSL_CONF"; then
    note '/etc/wsl.conf: 이미 generateResolvConf = false'
  else
    as_root install -o root -g root -m 0644 "$TMP/wsl.conf" "$WSL_CONF"   # 기존 줄은 그대로, [network] generateResolvConf = false만 더함
  fi
  as_root install -o root -g root -m 0644 "$TMP/wsl.conf" "$WSL_CONF_INSTALLED"   # 설치가 쓴 모습(제거 때 그 뒤 바뀌었는지 본다)
  # /etc/resolv.conf: 표시 줄 + 허용한 설정 줄(값 모양까지 검사)
  { printf '%s\n' "$RESOLV_FILE_MARK"; bash "$HERE/awbs-resolv-sync.sh" --filter < "$DNS_BASE"; } > "$TMP/resolv.conf"
  resolv_is_tunnel "$TMP/resolv.conf" || die "만든 DNS 설정에 nameserver $DNS_TUNNEL_NS 한 줄이 없습니다."
  if ((DRY_RUN)); then printf '\n--- 만들 파일: /etc/resolv.conf\n'; cat "$TMP/resolv.conf"; fi
  if [[ -L $RESOLV_DST && $(readlink -- "$RESOLV_DST") != "$RESOLV_SRC" ]] || { [[ -e $RESOLV_DST && ! -L $RESOLV_DST ]] && ! resolv_is_ours; }; then
    die "$RESOLV_DST가 WSL 링크도 이 설치가 만든 파일도 아니라 바꾸지 않습니다."
  fi
  if resolv_is_ours && cmp -s -- "$TMP/resolv.conf" "$RESOLV_DST"; then
    note '/etc/resolv.conf: 이미 실제 파일(같은 내용)'
  else
    # 같은 폴더의 임시 이름에 둔 뒤 이름 바꾸기로 한 번에 바꾼다. 링크 너머 원본(/mnt/wsl/resolv.conf)은 건드리지 않는다.
    as_root install -o root -g root -m 0644 "$TMP/resolv.conf" "$RESOLV_DST.awbs-new"
    as_root mv -fT -- "$RESOLV_DST.awbs-new" "$RESOLV_DST"
  fi
  printf 'tunnel\n' > "$TMP/dns-mode"
  as_root install -o root -g root -m 0644 "$TMP/dns-mode" "$DNS_MODE_RECORD"
  note '★ WSL을 한 번 다시 시작해야 설정이 굳어집니다: Windows에서 「wsl --shutdown」 후 터미널을 다시 열고 확인 스크립트를 실행하세요.'
}

# 대체(사본): 고정 주소가 아닌 PC. fix7 도우미에 리뷰7 지적을 반영한 단위를 쓴다.
#   - 서비스: 시작 한도 끔(StartLimitIntervalSec=0), 30초 시간 제한, 감시 뒤에 시작
#   - 타이머: 부팅 30초 뒤, 그 뒤 1분마다(감시가 놓치거나 멈춰도 1분 안에 복구)
dns_sync() {
  printf '\n   ★★★ 주의: 이 PC의 WSL DNS는 터널링 고정 주소(%s) 하나가 아닙니다.\n' "$DNS_TUNNEL_NS"
  printf '   ★★★ 그래서 대체 방식(도우미 + 감시 + 1분 타이머)으로 /etc/resolv.conf 사본을 유지합니다.\n'
  printf '   ★★★ WSL이 링크를 다시 만들 때 Agent의 이름 찾기가 최대 1분 끊길 수 있습니다. 이 사실을 보고해 주세요.\n\n'
  cat > "$TMP/resolv.service" << EOF
# Agent WBS(Q-08 fix8 대체 방식): WSL의 DNS 설정(/mnt/wsl/resolv.conf)을 /etc/resolv.conf 실제 파일로 옮긴다.
[Unit]
Description=Agent WBS: copy WSL DNS settings to /etc/resolv.conf for $AGENT_USER
After=local-fs.target $RESOLV_WATCH
ConditionPathExists=/mnt/wsl/resolv.conf
StartLimitIntervalSec=0

[Service]
Type=oneshot
TimeoutStartSec=30
ExecStart=/usr/local/libexec/awbs-resolv-sync

[Install]
WantedBy=multi-user.target
EOF
  cat > "$TMP/resolv.path" << EOF
# Agent WBS(Q-08 fix8 대체 방식): DNS 원본·/etc/resolv.conf가 바뀌면 $RESOLV_UNIT을 다시 실행한다.
[Unit]
Description=Agent WBS: re-copy WSL DNS settings when they change

[Path]
PathChanged=/mnt/wsl/resolv.conf
PathChanged=/etc/resolv.conf
Unit=$RESOLV_UNIT

[Install]
WantedBy=multi-user.target
EOF
  cat > "$TMP/resolv.timer" << EOF
# Agent WBS(Q-08 fix8 대체 방식): 감시가 변화를 놓치거나 멈춰도 1분 안에 다시 옮긴다(리뷰7 P2-1).
[Unit]
Description=Agent WBS: periodically re-copy WSL DNS settings

[Timer]
OnBootSec=30s
OnUnitInactiveSec=60s
Unit=$RESOLV_UNIT

[Install]
WantedBy=timers.target
EOF
  if ((DRY_RUN)); then
    for f in resolv.service resolv.path resolv.timer; do printf '\n--- 만들 파일: %s\n' "$f"; cat "$TMP/$f"; done
  fi
  ensure_root_dir "$(dirname "$RESOLV_SYNC_PATH")"
  ensure_root_dir "$(dirname "$RESOLV_UNIT_PATH")"
  as_root install -o root -g root -m 0755 "$HERE/awbs-resolv-sync.sh" "$RESOLV_SYNC_PATH"   # DNS 도우미(root 소유)
  as_root install -o root -g root -m 0644 "$TMP/resolv.service" "$RESOLV_UNIT_PATH"
  as_root install -o root -g root -m 0644 "$TMP/resolv.path" "$RESOLV_WATCH_PATH"
  as_root install -o root -g root -m 0644 "$TMP/resolv.timer" "$RESOLV_TIMER_PATH"
  as_root systemctl daemon-reload
  as_root systemctl enable "$RESOLV_UNIT"                                # 부팅 때 한 번
  as_root systemctl enable --now "$RESOLV_WATCH"                         # 바뀔 때마다
  as_root systemctl enable --now "$RESOLV_TIMER"                         # 1분마다(안전망)
  as_root systemctl start "$RESOLV_UNIT"                                 # 지금 한 번(실패하면 여기서 멈춘다)
  printf 'sync\n' > "$TMP/dns-mode"
  as_root install -o root -g root -m 0644 "$TMP/dns-mode" "$DNS_MODE_RECORD"
}

# ---------------------------------------------------------------- 1. 닫고 시작
step '1. 기존의 비밀번호 없는 실행 규칙을 먼저 지움(설치 중에는 Runner가 Agent를 띄우지 못하게)'
as_root rm -f -- "$SUDOERS_PATH"                                        # 다시 설치할 때도 끝까지 성공해야만 다시 넣는다

# ---------------------------------------------------------------- 2. 필요한 도구
step '2. 권한 목록(ACL) 도구 설치'
note 'ACL = 소유자·그룹 말고도 「이 계정에는 이 권한」을 따로 적는 기능. setfacl 명령이 필요하다.'
if ! command -v setfacl > /dev/null; then
  as_root apt-get install -y acl                                       # setfacl·getfacl이 든 acl 패키지 설치
else
  note '이미 설치됨'
fi

# ---------------------------------------------------------------- 3. Agent 계정
step "3. Agent 전용 계정 $AGENT_USER"
ensure_root_dir "$CONF_DIR"                                              # 설치 기록·래퍼 설정 폴더(root만 씀)
case $RESUME in
  finish) as_root rm -f -- "$PENDING_RECORD"; note '지난 설치의 진행 기록을 마무리함(계정·UID 기록은 이미 완료)' ;;
  rollback)
    note '지난 설치가 계정을 만들다 끊겼습니다. 진행 기록과 맞는 계정만 되돌린 뒤 새로 만듭니다.'
    if ((DRY_RUN)); then
      note "(실제 설치에서는 여기서 $PENDING_RECORD 기록으로 되돌린다)"
    else
      rollback_pending || die '지난 설치의 계정을 되돌리지 못했습니다(기록과 다른 계정). 손대지 않고 멈춥니다.'
    fi
    ACCOUNT=none ;;
esac
if [[ $ACCOUNT == none ]]; then
  NEW_UID=$(pick_free_uid) || die '비어 있는 시스템 UID(900~999)가 없습니다.'
  MARKER=awbs-agent-setup-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s %s %s\n' "$AGENT_USER" "$NEW_UID" "$MARKER" > "$TMP/agent-user.pending"
  # 계정을 만들기 「직전」에 이름·UID·생성 표식을 먼저 기록한다. 이 뒤로 실패하면 정리 코드가 이 기록으로 되돌린다(리뷰2 P2-B).
  as_root install -o root -g root -m 0644 "$TMP/agent-user.pending" "$PENDING_RECORD"
  CREATING=1
  # --system: 사람용이 아닌 시스템 계정. --uid: 방금 기록한 번호. --shell nologin: 로그인 셸로 들어올 수 없음.
  # --user-group: 같은 이름·번호의 전용 그룹. --comment: 이 설치가 만든 계정이라는 생성 표식.
  as_root useradd --system --uid "$NEW_UID" --user-group --create-home --home-dir "/home/$AGENT_USER" \
    --shell /usr/sbin/nologin --comment "Agent WBS agent $MARKER" "$AGENT_USER"
  if ((!DRY_RUN)); then
    # 만들어진 계정이 기록과 같은지 확인한다(같은 이름을 누가 먼저 만들었으면 여기서 멈춘다).
    [[ $(agent_entry_field 3) == "$NEW_UID" && $(agent_entry_field 5) == "Agent WBS agent $MARKER" ]] || die '만든 계정이 진행 기록과 다릅니다.'
  fi
  printf '%s\n' "$NEW_UID" > "$TMP/agent-user.uid"
  as_root install -o root -g root -m 0644 "$TMP/agent-user.uid" "$UID_RECORD"   # 「이 설치가 만든 계정」 기록(재설치·제거 때 대조)
  as_root rm -f -- "$PENDING_RECORD"                                       # 계정·UID 기록이 끝나 진행 기록은 지움
  CREATING=0
else
  note '이미 있음(이 설치가 만든 계정임을 확인함). 새로 만들지 않음'
fi
as_root passwd --lock "$AGENT_USER"                                      # 비밀번호 로그인을 잠금
# 아래 세 줄은 Agent 계정 권한으로 한다. Agent가 바꿀 수 있는 홈 안을 root가 다루면 링크를 따라갈 수 있기 때문이다(리뷰 P1-1).
as_agent chmod 0700 "$AGENT_HOME"                                        # Agent 홈(Claude·Codex 로그인 정보)은 Agent만 읽음
as_agent mkdir -p -m 0700 "$AGENT_HOME/tmp"                              # Agent 전용 임시 폴더(TMPDIR)
# git 2.43은 경로 접두어(/*)를 지원하지 않아 '*'를 쓴다. 작업 폴더는 Runner가 만들어 소유자가 다르기 때문이다.
as_agent git -C / config --global --replace-all safe.directory '*'

# ---------------------------------------------------------------- 3-1. 예약 실행 막기
step '3-1. Agent 계정의 예약 실행(cron·at) 막기'
note '왜: Agent가 세션 중에 예약 작업을 심으면 세션·Runner가 끝난 뒤에도 Agent 계정으로 명령이 계속 돈다.'
for deny in "$CRON_DENY" "$AT_DENY"; do
  rc=0; deny_has_agent "$deny" || rc=$?
  if ((rc == 0)); then note "$deny: 이미 있음"; continue; fi
  if ((rc == 2 && DRY_RUN)); then
    note "$deny: 관리자 권한 없이는 못 읽음. 실제 설치에서는 sudo로 읽고 $AGENT_USER 한 줄을 더한다"
    as_root install -o root -g root -m 0644 "$TMP/deny" "$deny"
    continue
  fi
  ((rc != 2)) || die "$deny를 읽지 못했습니다."
  # 기존 줄은 그대로 두고 Agent 계정 이름 한 줄만 더한 새 파일을 만들어 바꾼다(링크·소유자는 위에서 검사함).
  if [[ -e $deny ]]; then
    # 읽기만 root로 하고, 쓰는 곳은 Runner 계정의 임시 파일이다(의도한 동작).
    # shellcheck disable=SC2024
    if [[ -r $deny ]]; then cat -- "$deny" > "$TMP/deny"; else sudo cat -- "$deny" > "$TMP/deny"; fi
  else
    : > "$TMP/deny"
  fi
  printf '%s\n' "$AGENT_USER" >> "$TMP/deny"
  as_root install -o root -g root -m 0644 "$TMP/deny" "$deny"            # 이 계정은 crontab·at을 쓸 수 없음
done

# ---------------------------------------------------------------- 4. WSL 보호(실행 규칙보다 먼저)
step '4. WSL 보호(Windows 드라이브·Windows 프로그램 실행 통로 막기)'
if ((IS_WSL)); then
  note 'WSL에서는 /mnt/c 같은 Windows 드라이브를 누구나 읽고 쓸 수 있고, Windows 프로그램(.exe)을 실행하면 Windows 사용자 권한으로 돈다.'
  note '그래서 Agent 계정만 /mnt·/Docker·/run/WSL에 들어가지 못하게 막는다. Runner 계정은 그대로 쓸 수 있다.'
  for dir in "${WSL_BLOCK_DIRS[@]}"; do
    [[ -d $dir ]] || continue
    as_root setfacl -P -m "u:$AGENT_USER:---" "$dir"                     # 이 폴더에 Agent만 접근 금지(-P: 링크는 따라가지 않음)
  done
  ensure_root_dir "$(dirname "$GUARD_PATH")"
  as_root install -o root -g root -m 0644 "$TMP/guard.service" "$GUARD_PATH"   # 다음 부팅부터도 /run/WSL을 막는 서비스
  as_root systemctl daemon-reload                                        # 새 서비스 파일 읽기
  as_root systemctl enable "$GUARD_UNIT"                                 # 부팅 때 자동 실행
else
  note 'WSL이 아니라 건너뜀'
fi

# ---------------------------------------------------------------- 4-1. Agent DNS(fix8)
# Agent는 /mnt가 막혀 WSL의 DNS 설정(/mnt/wsl/resolv.conf)을 못 읽는다. /mnt는 그대로 막고 /etc/resolv.conf를 실제 파일로 둔다.
step '4-1. Agent 계정 DNS(이름 찾기)'
case $DNS_MODE in
  tunnel) dns_tunnel ;;
  sync) dns_sync ;;
  manual) note '/etc/resolv.conf는 직접 관리하는 파일이라 그대로 둠(Agent가 읽을 수 있는지는 7단계 래퍼 점검이 본다)' ;;
  *) note 'WSL이 아니라 건너뜀' ;;
esac

# ---------------------------------------------------------------- 5. 작업 영역
step "5. Agent 작업 영역 $AGENT_ROOT"
note '소유자 Runner, 그룹 Agent. Agent는 cli·inputs를 읽기만, worktrees 안에서만 쓴다.'
as_root install -d -o "$RUNNER_USER" -g "$AGENT_USER" -m 0750 "$AGENT_ROOT"            # 영역 자체: Runner 쓰기, Agent 들어가기만
as_root install -d -o "$RUNNER_USER" -g "$AGENT_USER" -m 2750 "$AGENT_ROOT/cli"        # Runner가 설치한 CLI: Agent는 읽기·실행만
as_root install -d -o "$RUNNER_USER" -g "$AGENT_USER" -m 2750 "$AGENT_ROOT/inputs"     # 입력 자료 사본: Agent는 읽기만
as_root install -d -o "$RUNNER_USER" -g "$AGENT_USER" -m 2750 "$AGENT_ROOT/worktrees"  # 작업 폴더 모음: 맨 위는 Agent가 못 바꿈
# 2750의 앞자리 2(setgid): 안에 새로 만드는 파일·폴더도 그룹이 Agent 그룹이 된다.
# 기본 ACL: worktrees 아래 새 폴더·파일에 Runner·Agent 권한 항목이 자동으로 붙는다.
# 주의: 새 폴더를 0700으로 만들면 ACL 상한(mask)이 ---가 되어 Agent 항목이 효과가 없다. 작업 폴더는 0770으로 만든다(isolation.md §6).
as_root setfacl -P -m "d:u:$RUNNER_USER:rwx,d:u:$AGENT_USER:rwx,d:g::r-x,d:m::rwx,d:o::---" "$AGENT_ROOT/worktrees"
as_root install -d -o root -g root -m 0755 "$AGENT_ROOT/runtime" "$AGENT_ROOT/runtime/node" "$AGENT_ROOT/runtime/node/bin"
as_root install -o root -g root -m 0755 "$NODE_BIN" "$AGENT_ROOT/runtime/node/bin/node"   # Agent용 node(Runner의 nvm은 Runner 홈 안이라 못 씀)

# ---------------------------------------------------------------- 6. 실행 래퍼와 설정
step '6. 실행 래퍼와 설정 파일'
ensure_root_dir "$(dirname "$EXEC_PATH")"
as_root install -o root -g root -m 0755 "$HERE/awbs-agent-exec.sh" "$EXEC_PATH"         # root 소유: Runner·Agent 누구도 못 고침
as_root install -o root -g root -m 0644 "$TMP/agent-exec.conf" "$CONF_PATH"             # 래퍼 설정(비밀값 없음)

# ---------------------------------------------------------------- 7. 점검
step '7. 래퍼 점검(Agent 계정으로 check). ok가 아니면 실행 규칙을 넣지 않고 멈춘다'
if ((DRY_RUN)); then
  as_agent "$EXEC_PATH" check
else
  result=$(as_agent "$EXEC_PATH" check) || true
  [[ $result == ok ]] || die "래퍼 점검이 ok가 아닙니다: $(printf '%s' "$result" | tr '\n' ' ')"
  note '래퍼 점검: ok'
fi

# ---------------------------------------------------------------- 8. sudoers(마지막)
step '8. sudoers 규칙(래퍼 하나만, Agent 계정으로만, 비밀번호 없이) — 모든 단계가 성공한 뒤에만'
ensure_root_dir "$(dirname "$SUDOERS_PATH")"
as_root /usr/sbin/visudo -c -q -f "$TMP/sudoers"                         # 문법 검사. 틀리면 여기서 멈춘다
as_root install -o root -g root -m 0440 "$TMP/sudoers" "$SUDOERS_PATH"   # sudoers 파일은 0440이어야 sudo가 읽는다
FINISHED=1

# ---------------------------------------------------------------- 끝
step '끝. 다음에 owner가 할 일'
cat << EOF
   순서는 agent-runner/docs/OWNER-RUNBOOK.md를 따릅니다(3단계부터).
   3) CLI 설치: bash $HERE/install-agent-cli.sh
   4) Agent 계정으로 Claude·Codex에 한 번 로그인
   5) Runner 환경 파일(agent-runner/.env)에 AWBS_AGENT_USER=$AGENT_USER 한 줄
   6) 확인: bash $HERE/check-agent-user.sh
EOF
((DRY_RUN)) && printf '\n(dry-run이라 아무것도 바꾸지 않았습니다.)\n'
exit 0
