#!/bin/bash
R=__ROOT__
printf '%s\n' "$*" >> "$R/sudo.log"
joined="$*"
if [[ -f $R/.sudo-rules ]]; then
  while IFS=$'\x1f' read -r code out glob; do
    [[ -z $code ]] && continue
    # shellcheck disable=SC2053
    if [[ $joined == $glob ]]; then printf '%b' "$out"; exit "$code"; fi
  done < "$R/.sudo-rules"
fi
# Agent 계정 명령: 기본은 적기만 한다(시험 계정으로 실제 실행하지 않는다). 거부 기본이면 「명령 실패」(rc=1)처럼 답한다.
if [[ $1 == -u || ( $1 == -n && $2 == -u ) ]]; then
  [[ -f $R/.agent-deny ]] && printf 'rc=1'
  exit 0
fi
[[ $1 == -k || $1 == -l ]] && exit 0
[[ $1 == -- ]] && shift
cmd=$1
shift
inside() { [[ $1 == "$R"/* ]] || { echo "가짜 루트 밖 경로: $1 ($cmd)" >&2; exit 99; }; }
case $cmd in
  install)
    dir=0 paths=()
    while (($#)); do case $1 in -o|-g|-m) shift 2 ;; -d) dir=1; shift ;; *) paths+=("$1"); shift ;; esac; done
    if ((dir)); then for p in "${paths[@]}"; do inside "$p"; mkdir -p "$p"; done
    else dst=${paths[-1]}; inside "$dst"; mkdir -p "$(dirname "$dst")"; cp "${paths[0]}" "$dst"; fi ;;
  rm | rmdir)
    for a in "$@"; do [[ $a == /* ]] && inside "$a"; done
    "$cmd" "$@" ;;
  setfacl | chown | chgrp | chmod)
    for a in "$@"; do [[ $a == /* ]] && inside "$a"; done ;;
  useradd) printf '%s\n' '__AGENT__' >> "$R/etc/passwd"; printf 'awbs-agent:x:998:\n' >> "$R/etc/group" ;;
  userdel) sed -i '/^awbs-agent:/d' "$R/etc/passwd" ;;
  groupdel) sed -i '/^awbs-agent:/d' "$R/etc/group" ;;
  pkill) [[ -s $R/.procs ]] || exit 1; [[ -f $R/.procs-stubborn ]] || : > "$R/.procs"; exit 0 ;;
  pgrep) [[ -s $R/.procs ]] && exit 0; exit 1 ;;
  *) exit 0 ;;
esac
