#!/usr/bin/env bash
# 운영 비밀 파일과 백업 폴더를 처음 한 번 만든다(M8-06). 이미 있으면 바꾸지 않는다.
#   bash agent-wbs/deploy/prod-init.sh
# 만드는 것(AWBS_PROD_HOME, 기본 ~/.agentwbs/prod):
#   secrets/db-password  DB 비밀번호(영문·숫자 48자), 권한 0600
#   secrets/secret-key   SMTP 비밀번호·Telegram 토큰·GitHub 토큰을 DB에 암호화해 넣을 때 쓰는 키(16진수 64자), 권한 0600
#   backups/             백업 폴더, 권한 0700
# 개발용 비밀(~/.agentwbs/wbs/dev-db-password, secret-key)과 일부러 다른 값을 쓴다. 왜: 개발 쪽이 새도 운영 데이터는 열리지 않게 한다.
set -euo pipefail
umask 077

home="${AWBS_PROD_HOME:-$HOME/.agentwbs/prod}"
case "$home" in /*) ;; *) echo "AWBS_PROD_HOME은 절대 경로여야 합니다: $home" >&2; exit 2 ;; esac

mkdir -p "$home" "$home/secrets" "$home/backups" && chmod 0700 "$home" "$home/secrets" "$home/backups"

create_once() { # $1 경로, $2 만드는 명령
  local path="$1"
  if [[ -e "$path" ]]; then
    echo "이미 있음(그대로 둠): $path"
  else
    local tmp
    tmp="$(mktemp "$path.XXXXXX")"
    "$2" > "$tmp"
    chmod 0600 "$tmp"
    mv -n "$tmp" "$path"
    rm -f "$tmp"
    echo "만듦: $path"
  fi
  local mode
  mode="$(stat -c '%a' "$path")"
  if [[ "$mode" != "600" ]]; then
    echo "권한이 600이 아닙니다($mode): $path → chmod 600 \"$path\" 를 실행하세요." >&2
    exit 1
  fi
}

new_password() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; echo; }
new_key() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; echo; }

create_once "$home/secrets/db-password" new_password
create_once "$home/secrets/secret-key" new_key

echo
echo "준비 완료: $home"
echo "주의: secrets/secret-key를 잃으면 DB에 암호화해 둔 SMTP 비밀번호·Telegram 토큰·GitHub 토큰을 다시 열 수 없습니다."
echo "      백업과 다른 곳(예: 암호 관리자)에 한 번 복사해 두세요. 백업 파일에는 일부러 넣지 않습니다."
