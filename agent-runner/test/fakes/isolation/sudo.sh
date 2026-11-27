#!/bin/bash
R=__ROOT__
printf '%s\n' "$*" >> "$R/sudo.log"
# 어느 폴더에서 불렸는지도 따로 적는다(Agent 명령이 Agent가 못 들어가는 폴더에서 돌지 않는지 시험).
printf '%s\n' "$PWD" >> "$R/sudo.cwd.log"
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
    # .root-can-enter에 적힌 폴더는 「Runner는 못 들어가지만 root는 들어가는」 폴더를 흉내 낸다(root 명령일 때만 잠시 연다).
    if [[ -f $R/.root-can-enter ]]; then
      while read -r d; do
        for a in "$@"; do [[ -n $d && $a == "$d"/* ]] && chmod 0700 "$d"; done
      done < "$R/.root-can-enter"
    fi
    "$cmd" "$@" ;;
  setfacl | chown | chgrp | chmod)
    for a in "$@"; do [[ $a == /* ]] && inside "$a"; done ;;
  useradd)
    # --uid·--comment를 받아 가짜 계정 파일에 한 줄 더한다. .useradd-line이 있으면 그 줄을 대신 쓴다(다른 계정이 끼어든 상황).
    uid=998 comment=''
    while (($#)); do case $1 in --uid) uid=$2; shift 2 ;; --comment) comment=$2; shift 2 ;; *) shift ;; esac; done
    if [[ -f $R/.useradd-line ]]; then cat "$R/.useradd-line" >> "$R/etc/passwd"
    else printf 'awbs-agent:x:%s:%s:%s:/home/awbs-agent:/usr/sbin/nologin\n' "$uid" "$uid" "$comment" >> "$R/etc/passwd"; fi
    printf 'awbs-agent:x:%s:\n' "$uid" >> "$R/etc/group" ;;
  userdel) sed -i '/^awbs-agent:/d' "$R/etc/passwd"; sed -i '/^awbs-agent:/d' "$R/etc/group" ;;
  cat) for a in "$@"; do [[ $a == /* ]] && inside "$a"; done; cat "$@" ;;
  test) for a in "$@"; do [[ $a == /* ]] && inside "$a"; done; test "$@" ;;
  find) for a in "$@"; do [[ $a == /* ]] && inside "$a"; done ;;
  groupdel) sed -i '/^awbs-agent:/d' "$R/etc/group" ;;
  pkill) [[ -s $R/.procs ]] || exit 1; [[ -f $R/.procs-stubborn ]] || : > "$R/.procs"; exit 0 ;;
  pgrep) [[ -s $R/.procs ]] && exit 0; exit 1 ;;
  *) exit 0 ;;
esac
