#!/bin/sh
# Agent WBS app 이미지 진입점(M8-06).
# 비밀값은 compose secrets 파일(/run/secrets/*)에서만 읽어 이 프로세스의 환경 변수로 넘긴다.
# 왜: 비밀값을 이미지·compose 파일·`docker inspect`에 남기지 않기 위해서다.
#
# 사용법(컨테이너 명령):
#   api      API 서버(REST·세션·Telegram 즉시 알림)
#   worker   worker(Runner 생존 감시·보고서 정기 생성·메일 발송·초기화 파일 삭제)
#   migrate  DB 마이그레이션 + 필수 기본 설정(seed system). 여러 번 실행해도 된다.
#   auth ... 인증 CLI(login-link | set-password | runner-token <ID> <공개키 파일> | revoke-runner)
set -eu

read_secret() {
  file="/run/secrets/$1"
  if [ ! -r "$file" ]; then
    echo "비밀 파일 $file 을(를) 읽을 수 없습니다. compose.prod.yaml의 secrets와 파일 권한을 확인하세요." >&2
    exit 64
  fi
  # 줄바꿈 문자만 지운다. 값 자체는 바꾸지 않는다.
  tr -d '\r\n' < "$file"
}

password=$(read_secret db_password)
secret_key=$(read_secret secret_key)
# DB 주소에 그대로 넣으므로 주소에서 특별한 뜻이 없는 문자만 허용한다(scripts/env-init.ts와 같은 규칙).
case "$password" in
  ''|*[!A-Za-z0-9_-]*) echo "db_password는 영문·숫자·_·-만 써야 합니다." >&2; exit 64 ;;
esac
case "$secret_key" in
  *[!0-9a-fA-F]*) echo "secret_key는 16진수 64자여야 합니다." >&2; exit 64 ;;
esac
if [ "${#secret_key}" -ne 64 ]; then echo "secret_key는 16진수 64자여야 합니다." >&2; exit 64; fi

export AWBS_SECRET_KEY="$secret_key"
export DATABASE_URL="postgres://awbs_owner:${password}@${AWBS_DB_HOST:-postgres}:5432/${AWBS_DB_NAME:-awbs}"
unset password secret_key

cd /app
command="${1:-api}"
[ "$#" -gt 0 ] && shift
case "$command" in
  api) exec node apps/api/dist/main.js ;;
  worker) exec node apps/api/dist/runner/worker.js ;;
  migrate)
    node packages/db/dist/migrate-cli.js
    exec node packages/db/dist/seed-cli.js system ;;
  auth) exec node apps/api/dist/platform/auth-cli.js "$@" ;;
  # 복원 리허설 전용 시험 자료. seed-cli가 DB 이름이 awbs_test_로 시작하지 않으면 거부하므로 운영 DB에는 들어가지 않는다.
  seed-demo) TEST_DATABASE_URL="$DATABASE_URL" exec node packages/db/dist/seed-cli.js demo ;;
  *) echo "알 수 없는 명령: $command (api | worker | migrate | auth | seed-demo)" >&2; exit 64 ;;
esac
