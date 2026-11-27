#!/usr/bin/env bash
# 설치 후 확인: Agent 전용 계정이 정말 격리됐는지 본다(Q-08). owner가 Runner 계정으로 실행한다.
#
#   bash agent-runner/scripts/isolation/check-agent-user.sh
#   bash agent-runner/scripts/isolation/check-agent-user.sh --protect /home/keeproll/projects/verum-sdn
#
# 옵션
#   --protect 경로   Agent가 읽으면 안 되는 폴더를 더 추가한다(여러 번 쓸 수 있음).
#
# 「Agent 계정으로 해 보기」 확인은 owner의 sudo 권한을 쓴다(처음에 비밀번호를 한 번 물음). 아무것도 고치지 않는다.
# 결과: 줄마다 PASS·FAIL·WARN. FAIL이 하나라도 있으면 종료 코드 1.
# 확인하지 못한 검사는 FAIL로 센다(fail-closed). 예: sudo 비밀번호가 틀려 Agent로 해 보지 못하면 「막힘」이 아니라 FAIL.
# bash 전용이다. sh(dash)로 부르면 pipefail에서 알 수 없는 오류가 나므로 여기서 먼저 멈춘다.
if [ -z "${BASH_VERSION:-}" ]; then echo "bash로 실행하세요. 예: bash $0" >&2; exit 2; fi
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$HERE/common.sh"

PROTECT=()
while (($#)); do
  case $1 in
    --protect) (($# >= 2)) || die '--protect에 경로가 필요합니다.' 2; PROTECT+=("$2"); shift 2 ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "모르는 옵션입니다: $1" 2 ;;
  esac
done
RUNNER_USER=$(id -un)
[[ $(id -u) != 0 && $RUNNER_USER != root ]] || die 'root가 아니라 Runner 계정으로 실행하세요.'
RUNNER_HOME=$(realpath -e -- "$HOME") || die "Runner 홈이 없습니다: $HOME"
[[ -n $ROOT_PREFIX ]] && note "시험 모드: 가짜 루트 $ROOT_PREFIX"

FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
warn() { printf 'WARN  %s\n' "$1"; }
finish() {
  printf '\n결과: FAIL %d개\n' "$FAILS"
  ((FAILS == 0)) && exit 0
  exit 1
}

# Agent 계정으로 명령을 해 보고 그 명령의 종료 코드를 돌려준다.
# sudo 자체가 실패하면(비밀번호 틀림 등) 명령은 돌지 않았으므로 255(=확인 못 함)를 돌려준다.
# 왜 구분하나: sudo 실패를 「Agent가 막혔다」로 읽으면 확인 못 한 검사가 PASS가 된다(리뷰 P2-6).
agent_rc() {
  local out
  out=$(sudo -u "$AGENT_USER" -H -- env -C / bash -c '"$@" > /dev/null 2>&1; printf "rc=%s" "$?"' _ "$@" 2> /dev/null) || true
  if [[ $out =~ ^rc=([0-9]+)$ ]]; then return "${BASH_REMATCH[1]}"; fi
  return 255
}
# 막혀야 PASS: 명령이 성공하면 FAIL, 확인 못 하면 FAIL.
agent_blocked() {
  local label=$1 rc=0
  shift
  agent_rc "$@" || rc=$?
  case $rc in
    0) fail "Agent가 할 수 있음: $label" ;;
    255) fail "확인 못 함(Agent로 실행 실패): $label" ;;
    *) pass "Agent가 못 함: $label" ;;
  esac
}
# 되어야 PASS: 명령이 실패하면 FAIL, 확인 못 하면 FAIL.
agent_allowed() {
  local label=$1 rc=0
  shift
  agent_rc "$@" || rc=$?
  case $rc in
    0) pass "Agent가 함: $label" ;;
    255) fail "확인 못 함(Agent로 실행 실패): $label" ;;
    *) fail "Agent가 못 함: $label" ;;
  esac
}
# 그 폴더 아래(자신 포함) Agent가 쓸 수 있는 것이 하나도 없어야 PASS. 다 읽지 못하면 FAIL(확인 못 함).
agent_tree_readonly() {
  local label=$1 dir=$2 rc=0
  # shellcheck disable=SC2016  # 작은따옴표 안은 Agent 쪽 bash가 펼친다.
  agent_rc bash -c 'f=$(find -P "$1" -writable -print -quit) || exit 2; [ -z "$f" ] || exit 3' _ "$dir" || rc=$?
  case $rc in
    0) pass "Agent가 하나도 못 고침: $label" ;;
    3) fail "Agent가 고칠 수 있는 파일·폴더가 있음: $label" ;;
    *) fail "확인 못 함(하위 폴더를 다 읽지 못함): $label" ;;
  esac
}

step '1. 계정'
state=$(agent_account_state)
case $state in
  none) fail "Agent 계정 $AGENT_USER가 없습니다. setup-agent-user.sh를 먼저 실행하세요."; finish ;;
  ours) pass "계정 $AGENT_USER: 설치 기록 UID·홈·셸(nologin)·전용 그룹과 일치, 다른 그룹 없음" ;;
  *) fail "계정 $AGENT_USER가 설치 기록과 다릅니다(UID·홈·셸·그룹 중 하나 이상 불일치, 다른 그룹 소속 포함)" ;;
esac

step '2. sudo 정책(Runner → Agent, 래퍼 하나만, 비밀번호 없이). 여기서 owner의 sudo 비밀번호를 물을 수 있음'
# 정책은 실행해 보는 대신 sudo가 보여 주는 허용 목록으로 본다.
# 왜: root로 실행이 허용돼도 래퍼가 「Agent 계정이 아님」으로 스스로 실패하므로, 실행 결과로는 허용 여부를 알 수 없다(리뷰 P2-6).
# 해석은 느슨하게 하지 않는다. 기대하는 줄과 「글자 그대로」 같은 줄만 통과하고, 그 밖의 줄은 모두 FAIL이다(리뷰2 P2-A).
#   - 규칙: Agent 규칙 한 줄(정확히 1번)과 owner의 관리자 규칙 `(ALL : ALL) ALL`(비밀번호 필요, 0~1번)만 허용.
#     예: `(root) NOPASSWD: /bin/bash`, 경로 와일드카드, `NOPASSWD: SETENV:`, `PASSWD:`가 섞인 줄, 별칭 이름은 모두 FAIL.
#   - 기본값: 알려진 안전한 항목(아래 목록)만 허용. 하나라도 다른 항목(예: !authenticate, env_keep, setenv)이 보이면 FAIL.
POLICY_RULE="($AGENT_USER) NOPASSWD: $REAL_EXEC_PATH"
# owner 관리자 규칙: 비밀번호가 필요한 흔한 표기들(리뷰3 P3). `%sudo` 그룹 경유와 직접 규칙이 겹치면 같은 줄이 여러 번 나올 수 있다.
POLICY_ADMIN=('(ALL : ALL) ALL' '(ALL:ALL) ALL' '(ALL) ALL' '(root) ALL' '(ALL : ALL) PASSWD: ALL' '(ALL:ALL) PASSWD: ALL' '(ALL) PASSWD: ALL')
# 비밀번호 없는 관리자 규칙: 인식만 하고 WARN(종료 코드에는 영향 없음). PASS로는 세지 않는다.
POLICY_ADMIN_NOPASSWD=('(ALL : ALL) NOPASSWD: ALL' '(ALL:ALL) NOPASSWD: ALL' '(ALL) NOPASSWD: ALL' '(root) NOPASSWD: ALL')
in_list() { local x=$1 k; shift; for k in "$@"; do [[ $x == "$k" ]] && return 0; done; return 1; }
POLICY_DEFAULTS=(env_reset mail_badpass use_pty
  'secure_path=/usr/local/sbin\:/usr/local/bin\:/usr/sbin\:/usr/bin\:/sbin\:/bin\:/snap/bin'
  'secure_path=/usr/local/sbin\:/usr/local/bin\:/usr/sbin\:/usr/bin\:/sbin\:/bin')
trim() { local v=$1; v=${v#"${v%%[![:space:]]*}"}; printf '%s' "${v%"${v##*[![:space:]]}"}"; }
check_policy() {
  local listing line t item section='' rules=0 admins=0 nopass=0 bad=0 known
  if ! listing=$(sudo -l -U "$RUNNER_USER" 2> /dev/null); then
    fail '확인 못 함: sudo 허용 목록을 읽지 못함'
    return
  fi
  while IFS= read -r line; do
    t=$(trim "$line")
    [[ -z $t ]] && continue
    case $t in
      "Matching Defaults entries for $RUNNER_USER on "*:) section=defaults; continue ;;
      "User $RUNNER_USER may run the following commands on "*:) section=rules; continue ;;
    esac
    if [[ $section == defaults && $line == [[:space:]]* ]]; then
      IFS=, read -r -a items <<< "$t"
      for item in "${items[@]}"; do
        item=$(trim "$item")
        known=0
        for k in "${POLICY_DEFAULTS[@]}"; do [[ $item == "$k" ]] && known=1; done
        if ((!known)); then fail "허용 목록에 없는 sudo 기본값: $item"; bad=1; fi
      done
    elif [[ $section == rules && $line == [[:space:]]* ]]; then
      if [[ $t == "$POLICY_RULE" ]]; then
        rules=$((rules + 1))
      elif in_list "$t" "${POLICY_ADMIN[@]}"; then
        admins=$((admins + 1))
      elif in_list "$t" "${POLICY_ADMIN_NOPASSWD[@]}"; then
        nopass=$((nopass + 1))
      else
        fail "허용 목록에 없는 sudo 규칙: $t"; bad=1
      fi
    else
      # 다른 머리말(예: Runas and Command-specific defaults)이나 위치를 알 수 없는 줄
      fail "확인 못 함: 해석하지 않는 sudo 출력 줄: $t"; bad=1
    fi
  done <<< "$listing"
  if [[ $section != rules ]]; then fail '확인 못 함: sudo 허용 목록 형식을 알 수 없음'; return; fi
  ((rules == 1)) || { fail "규칙 「$POLICY_RULE」이 정확히 1번 있어야 함(지금 ${rules}번)"; bad=1; }
  if ((nopass)); then
    warn "관리자 규칙(비밀번호 없음): Runner 계정이 비밀번호 없이 root가 될 수 있어, Agent 격리가 뚫리면 피해가 커집니다. 원하면 NOPASSWD를 빼세요."
  fi
  ((bad)) || pass "sudo 허용 목록이 기대와 같음: Agent 규칙 「$POLICY_RULE」 정확히 1번$( ((admins)) && printf ' + owner 관리자 규칙(비밀번호 필요) %s줄' "$admins")"
}
# 설치한 sudoers 파일도 설치 원본과 글자 그대로 같은지 본다(별칭·기본값을 몰래 더한 파일을 잡는다).
check_sudoers_file() {
  local actual
  if ! (safe_fixed_path "$SUDOERS_PATH") > /dev/null 2>&1; then
    fail "확인 못 함: $SUDOERS_PATH 경로에 링크나 예상 밖 소유자가 있음"
    return
  fi
  if ! actual=$(sudo cat -- "$SUDOERS_PATH" 2> /dev/null); then
    fail "확인 못 함: $SUDOERS_PATH를 읽지 못함"
    return
  fi
  if [[ $actual == "$(sudoers_content "$RUNNER_USER")" ]]; then
    pass "$SUDOERS_PATH가 설치 원본과 같음"
  else
    fail "$SUDOERS_PATH가 설치 원본과 다름"
  fi
}
check_policy
check_sudoers_file
# 실제로 비밀번호 없이 래퍼가 돌고, 래퍼 자신의 점검도 ok인지 본다.
sudo -k
if out=$(sudo -n -u "$AGENT_USER" -- "$REAL_EXEC_PATH" check 2>&1) && [[ $out == ok ]]; then
  pass 'Runner가 비밀번호 없이 래퍼를 Agent 계정으로 실행하고 래퍼 점검이 ok'
else
  fail "래퍼 실행 또는 래퍼 점검 실패: $(printf '%s' "$out" | tr '\n' ' ')"
fi

step '3. Agent 계정으로 해 보기 준비(owner의 sudo 비밀번호를 물을 수 있음)'
# 양성 대조: Agent로 아무 명령이나 실행되는지 먼저 본다. 안 되면 아래 「막힘」 결과를 믿을 수 없으므로 멈춘다.
rc=0; agent_rc true || rc=$?
if ((rc != 0)); then
  fail '확인 못 함: Agent 계정으로 명령을 실행하지 못함(sudo 비밀번호·권한 확인). 아래 검사를 할 수 없음'
  finish
fi
pass 'Agent 계정으로 명령 실행됨(아래 검사를 믿을 수 있음)'

step '4. Agent 계정이 못 읽어야 하는 곳'
targets=("$RUNNER_HOME" "$RUNNER_HOME/.agentwbs" "$RUNNER_HOME/.config/gh" "$RUNNER_HOME/.ssh" "$RUNNER_HOME/.orca" "$RUNNER_HOME/.claude" "$RUNNER_HOME/.codex")
for d in "$RUNNER_HOME"/projects/verum-* "$RUNNER_HOME"/.config/verum-* "${PROTECT[@]}"; do
  [[ -e $d ]] && targets+=("$d")
done
for t in "${targets[@]}"; do
  [[ -e $t ]] || continue
  agent_blocked "목록 읽기 $t" test -r "$t"
  agent_blocked "지나가기 $t" test -x "$t"
done
for f in "$RUNNER_HOME/.config/gh/hosts.yml" "$RUNNER_HOME/.bashrc"; do
  [[ -e $f ]] && agent_blocked "파일 읽기 $f" cat -- "$f"
done

step '5. WSL 탈출 통로'
# /mnt 아래는 하나도 빠짐없이 본다: 드라이브(c·d·x 등, 0777이라 하나라도 열리면 Windows 파일을 읽고 쓴다), wsl·wslg와 그 안쪽까지.
# 왜: /mnt를 통째로 막는 것이 기본이지만, 막힘이 하나라도 풀렸는지 이름마다 확인해야 「빠짐없음」을 증명할 수 있다(fix7).
wsl_targets=("$ROOT_PREFIX/mnt")
for t in "$ROOT_PREFIX"/mnt/* "$ROOT_PREFIX"/mnt/wsl/*; do
  [[ -e $t || -L $t ]] && wsl_targets+=("$t")
done
wsl_targets+=("$ROOT_PREFIX/run/WSL" "$ROOT_PREFIX/Docker" "$ROOT_PREFIX/Docker/host")
for t in "${wsl_targets[@]}"; do
  [[ -e $t ]] || continue
  # 목록 읽기와 지나가기를 따로 본다. 목록이 막혀도 이름을 알면 지나갈 수 있다(리뷰 P2-7).
  agent_blocked "목록 읽기 $t" test -r "$t"
  agent_blocked "지나가기 $t" test -x "$t"
done
if [[ -e $WSL_BINFMT ]]; then
  exe=$ROOT_PREFIX/mnt/c/Windows/System32/whoami.exe
  if [[ ! -f $exe ]]; then
    fail "확인 못 함: Windows 실행 시험에 쓸 $exe가 없음"
  else
    # Runner만 쓸 수 있는 폴더(0700)에 먼저 복사한다. Agent가 중간에 링크를 심어 Runner의 복사를 엉뚱한 곳으로 돌리지 못하게.
    probe=$(mktemp -d "$AGENT_ROOT/worktrees/.interop-XXXXXX")
    cp -- "$exe" "$probe/whoami.exe"
    chmod 0755 "$probe/whoami.exe"
    # 그다음 Agent가 읽고 실행만 할 수 있게 연다(0750 → ACL 상한 r-x). 0700 그대로면 폴더 때문에 막혀 시험이 무의미하다(리뷰 P2-5).
    chmod 0750 "$probe"
    # 실패하면 원인을 찾을 수 있게 오류 출력·종료 코드·WSL_INTEROP 값을 함께 보여 준다.
    rc_w=0
    err=$("$probe/whoami.exe" 2>&1 > /dev/null < /dev/null) || rc_w=$?
    if ((rc_w != 0)); then
      fail '확인 못 함: Runner 계정에서도 Windows 프로그램이 안 돎(대조 실패)'
      note "진단: 종료 코드 $rc_w, WSL_INTEROP=${WSL_INTEROP-(없음)}, 현재 폴더 $PWD"
      [[ -n $err ]] && note "진단: 오류 출력 $(printf '%s' "$err" | head -n 3 | tr '\n' ' ')"
    else
      rc_r=0; agent_rc test -r "$probe/whoami.exe" || rc_r=$?
      rc_x=0; agent_rc test -x "$probe/whoami.exe" || rc_x=$?
      if ((rc_r != 0 || rc_x != 0)); then
        fail '확인 못 함: Agent가 시험용 복사본을 읽거나 실행할 권한이 없음(통로 차단을 증명 못 함)'
      else
        agent_blocked 'Windows 실행 통로로 Windows 프로그램 실행(복사본은 읽기·실행 가능 확인)' "$probe/whoami.exe"
      fi
    fi
    rm -rf -- "$probe"
  fi
else
  pass 'WSL Windows 실행 통로 없음(WSL 아님)'
fi
agent_blocked 'Docker 소켓 쓰기(root와 같은 권한)' test -w "$ROOT_PREFIX/var/run/docker.sock"
agent_blocked 'Docker 소켓 읽기' test -r "$ROOT_PREFIX/var/run/docker.sock"

step '5-1. DNS(이름 찾기): Runner·Agent 양쪽'
# Claude·Codex 로그인과 실행에는 서버 이름(예: api.anthropic.com)을 주소로 바꾸는 DNS가 필요하다.
# WSL의 기본 /etc/resolv.conf는 /mnt/wsl/resolv.conf로 가는 링크라, /mnt가 막힌 Agent는 그대로면 못 읽는다.
# 설치(fix8)는 DNS 터널링이면 /etc/wsl.conf에 generateResolvConf = false를 넣고 /etc/resolv.conf를 실제 파일로 둔다.
DNS_NAME=api.anthropic.com
if [[ -e $WSL_BINFMT ]]; then
  dns_mode=''
  [[ -f $DNS_MODE_RECORD ]] && dns_mode=$(< "$DNS_MODE_RECORD")
  if [[ -L $RESOLV_DST ]]; then
    fail "/etc/resolv.conf가 아직 링크임($(readlink -- "$RESOLV_DST")). Agent가 따라가지 못함. setup-agent-user.sh를 다시 실행하세요(터널링이면 원본이 없어도 저장 사본으로 고침)"
  elif [[ -f $RESOLV_DST ]]; then
    pass '/etc/resolv.conf가 링크가 아닌 실제 파일'
  else
    fail '/etc/resolv.conf가 없음'
  fi
  case $dns_mode in
    tunnel)
      # WSL을 다시 시작해도 링크로 돌아가지 않게 하는 설정. 이것이 없으면 다음 재시작 때 Agent DNS가 다시 끊긴다.
      if wsl_conf_resolv_off "$WSL_CONF"; then
        pass '/etc/wsl.conf에 [network] generateResolvConf = false(WSL 재시작 뒤에도 실제 파일 유지)'
      else
        fail '/etc/wsl.conf에 [network] generateResolvConf = false가 없음(WSL 재시작 때 링크로 돌아감). setup-agent-user.sh를 다시 실행하세요'
      fi
      # 부팅 복구(fix9): 설치~재시작 틈에 링크가 굳어도 부팅 때 저장 사본으로 되살리는 서비스와 그 사본.
      if [[ -f $RESOLV_RESTORE_UNIT_PATH && -x $RESOLV_RESTORE_PATH ]] && [[ -f $RESOLV_INSTALLED ]] && resolv_is_tunnel "$RESOLV_INSTALLED"; then
        pass "부팅 복구 서비스($RESOLV_RESTORE_UNIT)와 저장 사본 있음"
      else
        fail "부팅 복구 서비스($RESOLV_RESTORE_UNIT) 또는 저장 사본($RESOLV_INSTALLED)이 없음. setup-agent-user.sh를 다시 실행하세요"
      fi
      if [[ -f $RESOLV_DST && ! -L $RESOLV_DST ]] && resolv_is_tunnel "$RESOLV_DST"; then
        pass "/etc/resolv.conf의 nameserver가 DNS 터널링 주소 $DNS_TUNNEL_NS 하나"
      else
        fail "/etc/resolv.conf의 nameserver가 $DNS_TUNNEL_NS 하나가 아님"
      fi
      ;;
    sync)
      warn '대체 방식(도우미 + 감시 + 1분 타이머): WSL이 링크를 다시 만들 때 Agent DNS가 최대 1분 끊길 수 있음'
      if systemctl is-active --quiet "$RESOLV_TIMER" 2> /dev/null; then pass "$RESOLV_TIMER 동작 중"; else fail "$RESOLV_TIMER가 동작하지 않음"; fi
      ;;
    *)
      fail "DNS 설정 방식 기록이 없음($DNS_MODE_RECORD). setup-agent-user.sh를 다시 실행하세요"
      ;;
  esac
fi
# Runner 쪽: 이 PC의 DNS 자체가 되는지(설정을 바꾼 뒤에도 owner·Runner 네트워크가 멀쩡한지).
runner_dns=0
if getent hosts "$DNS_NAME" > /dev/null 2>&1; then
  pass "Runner 계정 DNS 해석 $DNS_NAME"
  runner_dns=1
else
  fail "Runner 계정도 $DNS_NAME을 찾지 못함(인터넷 연결과 /etc/resolv.conf를 확인하세요)"
fi
agent_allowed "DNS 설정 파일 읽기 $RESOLV_DST" test -r "$RESOLV_DST"
if ((runner_dns)); then
  agent_allowed "DNS 해석 $DNS_NAME" getent hosts "$DNS_NAME"
else
  fail "확인 못 함: Runner DNS가 안 돼 Agent DNS를 판단할 수 없음"
fi
if [[ -e $RESOLV_SRC ]]; then
  agent_blocked "WSL DNS 원본 직접 읽기 $RESOLV_SRC(/mnt는 계속 막힘)" cat -- "$RESOLV_SRC"
fi

step '6. 작업 영역 권한'
agent_allowed "CLI 폴더 들어가기 $AGENT_ROOT/cli" test -x "$AGENT_ROOT/cli"
# 맨 위 폴더만이 아니라 버전 폴더·실행 파일·입력 사본 파일까지 본다(리뷰 P2-7).
agent_tree_readonly "CLI 설치본 전체 $AGENT_ROOT/cli" "$AGENT_ROOT/cli"
agent_tree_readonly "입력 자료 전체 $AGENT_ROOT/inputs" "$AGENT_ROOT/inputs"
agent_blocked "작업 폴더 모음 맨 위 바꾸기 $AGENT_ROOT/worktrees" test -w "$AGENT_ROOT/worktrees"
# Runner처럼 작업 폴더 하나를 만들고(0770: ACL 상한이 rwx가 되게), Agent가 그 안에 쓰고, Runner가 다시 지울 수 있는지 본다.
if probe_dir=$(mktemp -d "$AGENT_ROOT/worktrees/.check-XXXXXX" 2> /dev/null); then
  chmod 0770 "$probe_dir"
  # shellcheck disable=SC2016  # 작은따옴표 안은 Agent 쪽 bash가 펼친다.
  agent_allowed 'Runner가 만든 작업 폴더 안에 쓰기' bash -c 'mkdir "$1/sub" && echo x > "$1/sub/file"' _ "$probe_dir"
  if rm -rf -- "$probe_dir"; then pass 'Runner가 Agent가 만든 파일을 지움'; else fail 'Runner가 Agent가 만든 파일을 못 지움'; fi
else
  fail "Runner가 $AGENT_ROOT/worktrees 안에 폴더를 못 만듦"
fi

step '6-2. git safe.directory(소유자가 다른 저장소 허용)는 Agent 계정 전역 설정에만'
# Agent 계정 전역 설정의 safe.directory '*'는 Agent가 Runner(믿는 쪽) 소유 작업 폴더를 여는 데 필요하다(세션 안 git: status·diff·commit).
# Runner 쪽(Runner 전역·시스템 설정)에는 없어야 한다. 왜: Runner git이 Agent가 만든 저장소를 믿으면 Agent 설정(filter·hook)이 Runner 권한으로 돈다.
# shellcheck disable=SC2016  # 작은따옴표 안은 Agent 쪽 bash가 펼친다.
agent_allowed "Agent 계정 전역 설정 safe.directory='*'" bash -c '[[ $(git config --global --get-all safe.directory) == "*" ]]'
runner_safe=$(env -C / git config --get-all safe.directory 2> /dev/null || true)
if [[ -z $runner_safe ]]; then pass 'Runner 계정 git 설정(전역·시스템)에 safe.directory 없음'
else fail "Runner 계정 git 설정에 safe.directory가 있음(지우세요): $(printf '%s' "$runner_safe" | tr '\n' ' ')"; fi

step '6-1. 예약 실행(cron·at) 막힘'
# cron.allow(또는 at.allow)가 있으면 그 목록에 없는 계정은 막힌다. 없으면 deny 파일에 Agent가 있어야 한다.
for pair in "cron:$CRON_ALLOW:$CRON_DENY" "at:$AT_ALLOW:$AT_DENY"; do
  IFS=: read -r kind allow deny <<< "$pair"
  if [[ -e $allow ]]; then
    rc=0; deny_has_agent "$allow" || rc=$?
    case $rc in
      0) fail "$kind: $allow에 $AGENT_USER가 있어 예약 실행이 허용됨" ;;
      1) pass "$kind: $allow가 있고 $AGENT_USER는 없음(막힘)" ;;
      *) fail "확인 못 함: $allow를 읽지 못함" ;;
    esac
  else
    rc=0; deny_has_agent "$deny" || rc=$?
    case $rc in
      0) pass "$kind: $deny에 $AGENT_USER가 있음(막힘)" ;;
      1) fail "$kind: $deny에 $AGENT_USER가 없어 예약 실행이 허용됨(setup-agent-user.sh를 다시 실행)" ;;
      *) fail "확인 못 함: $deny를 읽지 못함" ;;
    esac
  fi
done
# 이미 심어 둔 crontab이 없는지도 본다(파일 이름은 계정 이름 고정).
if [[ -e $CRON_SPOOL ]] || sudo test -e "$CRON_SPOOL" 2> /dev/null; then
  fail "Agent 계정의 crontab 파일이 있음: $CRON_SPOOL"
else
  pass 'Agent 계정의 crontab 파일 없음'
fi

step '7. 로그인 상태(돈이 들지 않는 상태 확인만, 경고만)'
for agent in claude codex; do
  bin=$AGENT_ROOT/cli/$agent/current/bin/$agent
  if [[ ! -e $bin ]]; then
    warn "$agent: Runner 설치본이 아직 없음($AGENT_ROOT/cli/$agent/current). Runner가 CLI를 설치한 뒤 다시 확인"
    continue
  fi
  run=(sudo -u "$AGENT_USER" -H -- env -C / -i HOME="/home/$AGENT_USER" PATH="$AGENT_ROOT/runtime/node/bin:/usr/bin:/bin" "$bin")
  ok=0
  if [[ $agent == claude ]]; then
    # Claude는 로그인 안 돼도 0으로 끝날 수 있어 JSON의 loggedIn 값을 본다.
    if "${run[@]}" auth status --json 2> /dev/null | grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true'; then ok=1; fi
  elif "${run[@]}" login status > /dev/null 2>&1; then
    ok=1
  fi
  if ((ok)); then pass "$agent: Agent 계정 로그인됨"; else warn "$agent: Agent 계정 로그인 안 됨. isolation.md 「로그인」 절대로 한 번 로그인"; fi
done

step '8. 참고(경고만)'
# /tmp는 모든 계정이 같이 쓴다. 다른 계정의 비공개 폴더는 못 읽는 게 정상이라 검색 오류로 멈추지 않게 한다(리뷰 P3-10).
count=$({ find "$ROOT_PREFIX/tmp" -maxdepth 2 -user "$RUNNER_USER" -perm -o=r 2> /dev/null || true; } | wc -l)
if ((count == 0)); then pass '/tmp에 Runner 계정의 공개 파일 없음'; else warn "/tmp에 Runner 계정 파일 중 누구나 읽을 수 있는 것이 ${count}개 있음(Agent도 읽을 수 있음)"; fi

finish
