#!/usr/bin/env bash
# awbs-resolv-sync — WSL의 DNS 설정을 Agent 계정도 읽을 수 있는 실제 파일(/etc/resolv.conf)로 옮긴다(Q-08 fix7·fix8).
#
# 쓰임새는 두 가지다.
#   1) 설정 줄 걸러내기(관리자 권한 없음): `awbs-resolv-sync.sh --filter < 파일`
#      허용한 설정 줄만 표준 출력으로 낸다. 설치 스크립트가 /etc/resolv.conf 실제 파일 내용을 만들 때 쓴다.
#   2) 대체 방식(fix8): DNS 터널링 고정 주소가 아닌 PC에서만 설치된다.
#      설치 위치 /usr/local/libexec/awbs-resolv-sync (root 소유, 0755). systemd 서비스가 root로 인자 없이 실행한다.
#      부팅 때·원본이나 /etc/resolv.conf가 바뀔 때(path 감시)·1분마다(타이머) 다시 옮긴다.
#
# 왜 필요한가
#   - WSL은 /etc/resolv.conf를 /mnt/wsl/resolv.conf로 가는 링크로 만든다.
#   - Agent 계정은 /mnt 전체가 막혀 있다(Windows 드라이브 /mnt/c 등을 막기 위해). 그래서 링크를 따라가지 못해 DNS가 안 된다.
#
# 안전 규칙
#   - 원본은 링크가 아닌 일반 파일이고 root 소유일 때만 읽는다. 열 때도 링크를 따라가지 않는다(dd iflag=nofollow, 리뷰7 P3-1).
#   - 정해진 설정 줄만, 값 모양까지 검사해서 옮긴다(nameserver는 IP 주소만, 리뷰7 P3-5). nameserver 줄이 없으면 바꾸지 않는다.
#   - /etc/resolv.conf가 「원본으로 가는 WSL 링크」이거나 「이 설치가 만든 파일(첫 줄 표시)」일 때만 바꾼다.
#   - 새 파일은 같은 폴더의 임시 파일에 쓴 뒤 이름 바꾸기(mv)로 한 번에 바꾼다.
#   - 바꾼 뒤 잠깐 기다렸다가 WSL이 다시 링크로 만들었으면 다시 옮긴다(최대 5번). systemd는 서비스가 도는 동안의 변화를 놓치기 때문이다(리뷰7 P2-1).
if [ -z "${BASH_VERSION:-}" ]; then echo "bash로 실행하세요. 예: bash $0" >&2; exit 2; fi
set -euo pipefail
umask 0022
export LC_ALL=C

SRC=/mnt/wsl/resolv.conf
DST=/etc/resolv.conf
SRC_OWNER_UID=0
RECHECK_DELAY=1
MARK='# Agent WBS(Q-08): /mnt/wsl/resolv.conf(WSL이 만든 원본)에서 awbs-resolv-sync가 옮긴 사본. 원본이 바뀌면 다시 옮긴다.'
# 터널링 방식에서 설치 스크립트가 만든 파일의 첫 줄(common.sh의 RESOLV_FILE_MARK와 같다). 이 파일도 「이 설치가 만든 파일」로 본다.
FILE_MARK='# Agent WBS(Q-08): WSL DNS 터널링 설정으로 owner 설치가 만든 파일. /etc/wsl.conf의 generateResolvConf = false로 WSL이 바꾸지 않는다.'

say() { printf 'awbs-resolv-sync: %s\n' "$1"; }
die() { printf 'awbs-resolv-sync: %s\n' "$1" >&2; exit "${2:-1}"; }

# 허용한 설정 줄만 표준 출력으로 낸다. 값 모양도 본다.
#   nameserver <IPv4 또는 IPv6>     search·domain <이름...>     options <낱말...>     sortlist <주소/마스크...>
filter_lines() {
  local ipv4='[0-9]{1,3}(\.[0-9]{1,3}){3}'
  local ipv6='[0-9A-Fa-f]*:[0-9A-Fa-f:.]*(%[A-Za-z0-9_.-]+)?'
  local name='[A-Za-z0-9_][A-Za-z0-9_.-]*'
  grep -E \
    -e "^nameserver[[:blank:]]+(${ipv4}|${ipv6})[[:blank:]]*$" \
    -e "^(search|domain)([[:blank:]]+${name})+[[:blank:]]*$" \
    -e '^options([[:blank:]]+[A-Za-z0-9_:.-]+)+[[:blank:]]*$' \
    -e '^sortlist([[:blank:]]+[0-9./]+)+[[:blank:]]*$' || true
}

if [[ ${1-} == --filter ]]; then
  filter_lines
  exit 0
fi
(($# == 0)) || die "인자는 --filter 하나만 받습니다." 2

# 바꿔도 되는 상태인가. 0 = 바꿔도 됨, 3 = 건드리지 않음(그대로 두고 성공으로 끝냄)
dst_state() {
  if [[ -L $DST ]]; then
    local target
    target=$(readlink -- "$DST")
    [[ $target == "$SRC" ]] && return 0
    say "$DST가 다른 곳($target)을 가리키는 링크라 건드리지 않습니다."
    return 3
  elif [[ -f $DST ]]; then
    local first
    first=$(head -n 1 -- "$DST" || true)
    [[ $first == "$MARK" || $first == "$FILE_MARK" ]] && return 0
    say "$DST는 직접 관리하는 파일이라 건드리지 않습니다."
    return 3
  elif [[ -e $DST ]]; then
    die "$DST가 일반 파일도 링크도 아닙니다."
  fi
  return 0
}

# 한 번 옮긴다. 0 = 바꿈, 4 = 이미 최신·건드리지 않음·원본 없음
sync_once() {
  local rc=0
  dst_state || rc=$?
  ((rc == 0)) || return 4
  if [[ ! -e $SRC && ! -L $SRC ]]; then say "원본($SRC)이 없어 그대로 둡니다."; return 4; fi
  [[ -f $SRC && ! -L $SRC ]] || die "원본이 링크이거나 일반 파일이 아닙니다: $SRC"
  [[ $(stat -c %u -- "$SRC") == "$SRC_OWNER_UID" ]] || die "원본이 root 소유가 아닙니다: $SRC"
  # 링크를 따라가지 않고(nofollow), 이름 있는 파이프여도 기다리지 않고(nonblock) 최대 65537바이트만 읽는다.
  local content
  content=$(dd if="$SRC" iflag=nofollow,nonblock bs=65537 count=1 status=none) || die "원본을 읽지 못했습니다: $SRC"
  ((${#content} <= 65536)) || die "원본이 너무 큽니다."
  local new
  new=$(mktemp "$DST.awbs-XXXXXX")
  # shellcheck disable=SC2064  # 지금 정해진 임시 파일 이름을 trap에 넣는다.
  trap "rm -f -- '$new'" EXIT
  { printf '%s\n' "$MARK"; printf '%s\n' "$content" | filter_lines; } > "$new"
  if ! grep -q '^nameserver[[:blank:]]' "$new"; then
    rm -f -- "$new"
    die "원본에 쓸 수 있는 nameserver 줄이 없어 바꾸지 않습니다."
  fi
  if [[ -f $DST && ! -L $DST ]] && cmp -s -- "$new" "$DST"; then
    rm -f -- "$new"
    trap - EXIT
    say '이미 최신입니다.'
    return 4
  fi
  chmod 0644 -- "$new"
  mv -fT -- "$new" "$DST"
  trap - EXIT
  say "$DST를 원본 내용으로 바꿨습니다(Agent 계정도 읽을 수 있음)."
  return 0
}

# 바꾼 뒤 잠깐 기다린다(그 사이 WSL이 다시 링크로 만들면 아래에서 다시 옮긴다).
after_swap() { sleep "$RECHECK_DELAY"; }

for ((try = 1; try <= 5; try++)); do
  rc=0
  sync_once || rc=$?
  ((rc == 0)) || exit 0
  after_swap
  # 다시 WSL 링크가 됐을 때만 한 번 더. 그대로면 끝.
  [[ -L $DST && $(readlink -- "$DST") == "$SRC" ]] || exit 0
  say "옮긴 뒤 WSL이 다시 링크로 만들었습니다. 다시 옮깁니다($try/5)."
done
die "WSL이 계속 링크로 되돌립니다. 타이머가 1분 안에 다시 시도합니다."
