#!/bin/sh
# Agent WBS app 이미지 진입점(M8-06).
# 비밀값은 compose secrets 파일(/run/secrets/*)에서 읽어, 실행할 프로그램 하나의 환경 변수로만 넘긴다.
# 왜: 비밀값이 이미지·compose 파일·`docker inspect` 구성 정보에 남지 않게 한다.
#     (실행 중인 그 프로그램의 환경에는 DATABASE_URL·AWBS_SECRET_KEY가 있다. 그 프로그램이 써야 하기 때문이다.)
#
# DB 로그인은 둘로 나뉜다(data-model §6.1).
#   관리자 awbs_owner(db_password)  : migrate·seed-demo만 쓴다. api·worker 컨테이너에는 이 파일을 붙이지 않는다.
#   앱 awbs_app_login(db_app_password): api·worker·auth·db-check가 쓴다. awbs_app 권한만 물려받는다.
#
# 사용법(컨테이너 명령):
#   api       API 서버(REST·세션·Telegram 즉시 알림)
#   worker    worker(Runner 생존 감시·보고서 정기 생성·메일 발송·초기화 파일 삭제)
#   migrate   DB 마이그레이션 + 필수 기본 설정(seed system) + 앱 로그인 준비. 여러 번 실행해도 된다.
#   auth ...  인증 CLI(login-link | set-password | runner-token <ID> <공개키 파일> | revoke-runner)
#   db-check  앱 로그인의 권한 확인(관리자가 아닌지, 이력을 지울 수 없는지). JSON 한 줄, 안전하지 않으면 종료 코드 1
#   seed-demo 복원 리허설 전용 시험 자료(DB 이름이 awbs_test_로 시작할 때만 동작)
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

check_password() { # DB 주소에 그대로 넣으므로 주소에서 특별한 뜻이 없는 문자만 허용한다(scripts/env-init.ts와 같은 규칙).
  case "$1" in
    ''|*[!A-Za-z0-9_-]*) echo "$2 는 영문·숫자·_·-만 써야 합니다." >&2; exit 64 ;;
  esac
}

load_secret_key() {
  secret_key=$(read_secret secret_key)
  case "$secret_key" in
    *[!0-9a-fA-F]*) echo "secret_key는 16진수 64자여야 합니다." >&2; exit 64 ;;
  esac
  if [ "${#secret_key}" -ne 64 ]; then echo "secret_key는 16진수 64자여야 합니다." >&2; exit 64; fi
  export AWBS_SECRET_KEY="$secret_key"
  unset secret_key
}

db_url() { # $1 사용자, $2 비밀번호
  export DATABASE_URL="postgres://$1:$2@${AWBS_DB_HOST:-postgres}:5432/${AWBS_DB_NAME:-awbs}"
}

as_app() {
  password=$(read_secret db_app_password)
  check_password "$password" db_app_password
  db_url awbs_app_login "$password"
  unset password
}

as_admin() {
  password=$(read_secret db_password)
  check_password "$password" db_password
  db_url awbs_owner "$password"
  unset password
}

cd /app
command="${1:-api}"
[ "$#" -gt 0 ] && shift
case "$command" in
  api) as_app; load_secret_key; exec node apps/api/dist/main.js ;;
  worker) as_app; load_secret_key; exec node apps/api/dist/runner/worker.js ;;
  auth) as_app; load_secret_key; exec node apps/api/dist/platform/auth-cli.js "$@" ;;
  db-check) as_app; exec node packages/db/dist/app-login-cli.js check ;;
  migrate)
    as_admin
    app_password=$(read_secret db_app_password)
    check_password "$app_password" db_app_password
    node packages/db/dist/migrate-cli.js
    node packages/db/dist/seed-cli.js system
    AWBS_APP_DB_PASSWORD="$app_password" exec node packages/db/dist/app-login-cli.js ensure ;;
  # 복원 리허설 전용 시험 자료. seed-cli가 DB 이름이 awbs_test_로 시작하지 않으면 거부하므로 운영 DB에는 들어가지 않는다.
  seed-demo) as_admin; TEST_DATABASE_URL="$DATABASE_URL" exec node packages/db/dist/seed-cli.js demo ;;
  *) echo "알 수 없는 명령: $command (api | worker | migrate | auth | db-check | seed-demo)" >&2; exit 64 ;;
esac
