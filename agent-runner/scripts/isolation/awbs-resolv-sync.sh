#!/usr/bin/env bash
# awbs-resolv-sync — WSL의 DNS 설정을 Agent 계정도 읽을 수 있는 실제 파일(/etc/resolv.conf)로 옮긴다(Q-08 fix7).
#
# 설치 위치: /usr/local/libexec/awbs-resolv-sync (root 소유, 0755). setup-agent-user.sh가 설치하고,
# systemd 서비스(awbs-agent-resolv.service)가 root로 실행한다. 부팅 때 한 번, 그리고 원본이나 /etc/resolv.conf가
# 바뀔 때마다(awbs-agent-resolv.path) 다시 실행한다.
#
# 왜 필요한가
#   - WSL은 /etc/resolv.conf를 /mnt/wsl/resolv.conf로 가는 링크로 만든다.
#   - Agent 계정은 /mnt 전체가 막혀 있다(Windows 드라이브 /mnt/c 등을 막기 위해). 그래서 링크를 따라가지 못해 DNS(이름→주소)가 안 된다.
#   - /mnt를 조금 여는 대신, 그 안의 DNS 설정만 /etc 쪽 실제 파일로 옮긴다. /mnt는 그대로 막힌 채로 둔다.
#
# 안전 규칙
#   - 원본은 링크가 아닌 일반 파일이고 root 소유일 때만 읽는다(다른 계정이 심은 링크로 root가 비밀 파일을 복사하지 않게).
#   - 정해진 설정 줄(nameserver·search·domain·options·sortlist)만 옮긴다. nameserver 줄이 없으면 바꾸지 않는다.
#   - /etc/resolv.conf가 「원본으로 가는 WSL 링크」이거나 「이 스크립트가 만든 파일」일 때만 바꾼다.
#     owner가 직접 관리하는 파일·다른 링크(systemd-resolved 등)는 건드리지 않고 0으로 끝난다.
#   - 새 파일은 같은 폴더의 임시 파일에 쓴 뒤 이름 바꾸기(mv)로 한 번에 바꾼다(중간 상태가 보이지 않게).
if [ -z "${BASH_VERSION:-}" ]; then echo "bash로 실행하세요. 예: bash $0" >&2; exit 2; fi
set -euo pipefail
umask 0022
export LC_ALL=C

SRC=/mnt/wsl/resolv.conf
DST=/etc/resolv.conf
SRC_OWNER_UID=0
MARK='# Agent WBS(Q-08): /mnt/wsl/resolv.conf(WSL이 만든 원본)에서 awbs-resolv-sync가 옮긴 사본. 원본이 바뀌면 다시 옮긴다.'

say() { printf 'awbs-resolv-sync: %s\n' "$1"; }
die() { printf 'awbs-resolv-sync: %s\n' "$1" >&2; exit "${2:-1}"; }

# 1) 대상 확인: 바꿔도 되는 상태인가
if [[ -L $DST ]]; then
  target=$(readlink -- "$DST")
  if [[ $target != "$SRC" ]]; then say "$DST가 다른 곳($target)을 가리키는 링크라 건드리지 않습니다."; exit 0; fi
elif [[ -f $DST ]]; then
  first=$(head -n 1 -- "$DST" || true)
  if [[ $first != "$MARK" ]]; then say "$DST는 직접 관리하는 파일이라 건드리지 않습니다."; exit 0; fi
elif [[ -e $DST ]]; then
  die "$DST가 일반 파일도 링크도 아닙니다."
fi

# 2) 원본 확인: 링크가 아닌 일반 파일, root 소유, 64KB 이하
if [[ ! -e $SRC && ! -L $SRC ]]; then say "원본($SRC)이 없어 그대로 둡니다."; exit 0; fi
[[ -f $SRC && ! -L $SRC ]] || die "원본이 링크이거나 일반 파일이 아닙니다: $SRC"
[[ $(stat -c %u -- "$SRC") == "$SRC_OWNER_UID" ]] || die "원본이 root 소유가 아닙니다: $SRC"
# 연 파일을 다시 확인한다(검사와 읽기 사이에 바꿔치기돼도 연 파일 자체를 본다).
exec 3< "$SRC"
[[ -f /dev/fd/3 ]] || die "연 원본이 일반 파일이 아닙니다."
read -r f_uid f_size < <(stat -L -c '%u %s' /dev/fd/3)
[[ $f_uid == "$SRC_OWNER_UID" ]] || die "연 원본이 root 소유가 아닙니다."
((f_size <= 65536)) || die "원본이 너무 큽니다(${f_size}바이트)."

# 3) 새 내용: 표시 줄 + 허용한 설정 줄만
new=$(mktemp "$DST.awbs-XXXXXX")
trap 'rm -f -- "$new"' EXIT
{
  printf '%s\n' "$MARK"
  grep -E '^(nameserver|search|domain|options|sortlist)[[:blank:]]+[[:graph:]][[:print:]]*$' <&3 || true
} > "$new"
exec 3<&-
grep -q '^nameserver[[:blank:]]' "$new" || die "원본에 nameserver 줄이 없어 바꾸지 않습니다."

# 4) 같으면 그대로, 다르면 한 번에 바꾼다
if [[ -f $DST && ! -L $DST ]] && cmp -s -- "$new" "$DST"; then
  say '이미 최신입니다.'
  exit 0
fi
chmod 0644 -- "$new"
mv -fT -- "$new" "$DST"
trap - EXIT
say "$DST를 원본 내용으로 바꿨습니다(Agent 계정도 읽을 수 있음)."
