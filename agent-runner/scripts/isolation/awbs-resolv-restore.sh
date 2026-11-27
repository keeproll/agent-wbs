#!/usr/bin/env bash
# awbs-resolv-restore — 부팅 때 한 번: /etc/resolv.conf가 링크로 남아 있으면 저장 사본으로 실제 파일을 되살린다(Q-08 fix9).
#
# 설치 위치: /usr/local/libexec/awbs-resolv-restore (root 소유, 0755). 터널링 방식에서만 설치된다.
# systemd 서비스(awbs-agent-resolv-restore.service)가 부팅 때 한 번, /etc/resolv.conf가 링크일 때만 root로 실행한다.
#
# 왜 필요한가(리뷰8 P2-1)
#   - /etc/wsl.conf의 generateResolvConf = false는 WSL을 다시 시작해야 적용된다.
#   - 설치와 재시작 사이에 wsl.exe가 돌면 WSL이 /etc/resolv.conf를 다시 링크로 만든다. 그 링크가 재시작 뒤 그대로 굳는다.
#   - 그때 링크가 가리키는 원본(/mnt/wsl/resolv.conf)이 없으면 모든 계정의 DNS가 끊긴다.
#   - 자동 생성이 꺼진 뒤라 WSL과 싸우지 않는다. 그래서 부팅 때 한 번이면 된다(감시·타이머 없음).
#
# 안전 규칙
#   - 방식 기록이 「tunnel」일 때만 움직인다.
#   - /etc/resolv.conf가 링크일 때만 바꾼다. 실제 파일이면(이미 정상이거나 owner가 관리) 건드리지 않는다.
#   - 저장 사본은 root만 쓰는 /etc/agentwbs 안의 root 소유 일반 파일이고, 첫 줄 표시와 nameserver 한 줄(고정 주소)이 맞을 때만 쓴다.
#     맞지 않으면 고정 주소 한 줄로 만든다.
#   - 같은 폴더의 임시 파일에 쓴 뒤 이름 바꾸기(mv)로 한 번에 바꾼다.
if [ -z "${BASH_VERSION:-}" ]; then echo "bash로 실행하세요. 예: bash $0" >&2; exit 2; fi
set -euo pipefail
umask 0022
export LC_ALL=C

DST=/etc/resolv.conf
MODE_RECORD=/etc/agentwbs/dns-mode
SAVED=/etc/agentwbs/resolv.conf.installed
OWNER_UID=0
NS=10.255.255.254
FILE_MARK='# Agent WBS(Q-08): WSL DNS 터널링 설정으로 owner 설치가 만든 파일. /etc/wsl.conf의 generateResolvConf = false로 WSL이 바꾸지 않는다.'

say() { printf 'awbs-resolv-restore: %s\n' "$1"; }

mode=''
[[ -f $MODE_RECORD && ! -L $MODE_RECORD ]] && mode=$(head -c 16 -- "$MODE_RECORD" | tr -d '[:space:]')
if [[ $mode != tunnel ]]; then say '터널링 방식이 아니라 아무것도 하지 않습니다.'; exit 0; fi
if [[ ! -L $DST ]]; then say "$DST가 링크가 아니라 그대로 둡니다."; exit 0; fi

# 저장 사본이 믿을 만하면 그것을, 아니면 고정 주소 한 줄을 쓴다.
content="$FILE_MARK"$'\n'"nameserver $NS"
if [[ -f $SAVED && ! -L $SAVED ]] && [[ $(stat -c %u -- "$SAVED") == "$OWNER_UID" ]] && (($(stat -c %s -- "$SAVED") <= 65536)); then
  saved=$(dd if="$SAVED" iflag=nofollow,nonblock bs=65537 count=1 status=none) || saved=''
  first=${saved%%$'\n'*}
  ns=$(printf '%s\n' "$saved" | awk '$1 == "nameserver" { print $2 }')
  if [[ $first == "$FILE_MARK" && $ns == "$NS" ]]; then
    content=$saved
  else
    say '저장 사본이 예상한 모양이 아니라 고정 주소 한 줄로 만듭니다.'
  fi
else
  say '저장 사본이 없거나 믿을 수 없어 고정 주소 한 줄로 만듭니다.'
fi

new=$(mktemp "$DST.awbs-XXXXXX")
trap 'rm -f -- "$new"' EXIT
printf '%s\n' "$content" > "$new"
chmod 0644 -- "$new"
mv -fT -- "$new" "$DST"
trap - EXIT
say "$DST 링크를 실제 파일로 되살렸습니다(nameserver $NS)."
