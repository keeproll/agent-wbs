#!/usr/bin/env bash
# 복원 리허설(M8-06). 운영(awbs-prod)은 건드리지 않고, 임시 구성 두 개로 「백업 → 새 DB에 복원 → 앱 기동 → 데이터 대조」를 끝까지 해 본다.
#   bash agent-wbs/deploy/restore-rehearsal.sh            # 저장소 맨 위 폴더에서
#   KEEP=1 bash agent-wbs/deploy/restore-rehearsal.sh     # 끝난 뒤 임시 구성을 지우지 않고 남김(직접 살펴볼 때)
#
# 임시 구성
#   원본: awbs-rh-src (화면 127.0.0.1:25481)  시험 자료(seed demo)·데이터 파일 표식을 넣는다.
#   대상: awbs-rh-dst (화면 127.0.0.1:25482)  원본 백업을 되살린다.
#   DB 이름: awbs_test_rehearsal. 왜: 시험 자료 넣기(seed demo)는 awbs_test_로 시작하는 DB에만 허락된다.
#   비밀 파일·백업: $HOME/.agentwbs/rehearsal/<시각>/ (prod-init.sh로 새로 만든 리허설 전용 값)
# 대조하는 것
#   1. 표마다 행 수·내용 지문(restore.sh 안에서, 앱을 켜기 전)
#   2. 데이터 파일 표식의 sha256
#   3. 앱을 켠 뒤 같은 API 응답(로그인 → 여러 GET)이 원본과 같은지
#   4. 복원한 DB의 새 변경이 새 트랜잭션 번호(epoch +1)와 실제 커밋 시각을 받는지
#   5. 원본·대상 모두 api·worker가 관리자가 아닌 앱 로그인(awbs_app_login)으로 접속하고, 이력을 지울 수 없고, 관리자 비밀 파일이 없는지
#   6. 없는 이미지 꼬리표나 이미지 ID가 빠진 manifest로 복원하면 아무것도 만들기 전에 멈추는지(이미지 자동 빌드 없음)
#   7. 안내대로(runner:public-key → 나온 Runner ID로 토큰 발급) 하면 Runner heartbeat가 204이고, 옛 안내(runner-main)는 403인지
#      runner:public-key 명령은 gh-cred 작업(agent-runner/scripts/runner-public-key.ts)이 추가한다. 없으면 이 단계에서 멈춘다.
# 이미지는 미리 build.sh로 만들어 둔다. 이 스크립트는 이미지를 만들지 않는다.
#   AWBS_IMAGE_TAG=<꼬리표> bash agent-wbs/deploy/restore-rehearsal.sh
# 끝나면 임시 구성을 `docker compose down -v`로 지운다(그 구성의 컨테이너·이름 있는 볼륨만). docker volume prune은 쓰지 않는다.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="${REHEARSAL_HOME:-$HOME/.agentwbs/rehearsal/$stamp}"
src=awbs-rh-src
dst=awbs-rh-dst
src_port=25481
dst_port=25482
repo="$(cd "$here/../.." && pwd)"
: "${AWBS_IMAGE_TAG:?AWBS_IMAGE_TAG=<꼬리표>를 정하세요(build.sh로 만든 이미지)}"
for image in "awbs-app:$AWBS_IMAGE_TAG" "awbs-web:$AWBS_IMAGE_TAG"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "이미지 $image 가 없습니다. 먼저 build.sh로 만드세요." >&2; exit 3; }
done
neg=awbs-rh-neg
export AWBS_PROD_HOME="$work" AWBS_DB_NAME=awbs_test_rehearsal AWBS_IMAGE_TAG
result="$work/rehearsal-result.txt"

log() { printf '[rehearsal %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$result" >&2; }
dc() { local stack="$1" port="$2"; shift 2; AWBS_STACK="$stack" AWBS_WEB_PORT="$port" docker compose -p "$stack" -f "$here/compose.prod.yaml" "$@"; }
psql_on() { local stack="$1"; shift; docker exec -i "$stack-postgres" psql -X -q -v ON_ERROR_STOP=1 -U awbs_owner -d "$AWBS_DB_NAME" "$@"; }

for stack in "$src" "$dst" "$neg"; do
  for thing in "$stack-pgdata" "$stack-data"; do
    if docker volume inspect "$thing" >/dev/null 2>&1; then echo "이전 리허설의 볼륨 $thing 이(가) 남아 있습니다. 지운 뒤 다시 실행하세요: docker compose -p $stack -f agent-wbs/deploy/compose.prod.yaml down -v" >&2; exit 3; fi
  done
done
for port in "$src_port" "$dst_port"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "포트 $port 를 이미 누가 쓰고 있습니다." >&2; exit 3; fi
done

mkdir -p "$work" && chmod 0700 "$work"
: > "$result"
cleanup() {
  if [[ "${KEEP:-}" == 1 ]]; then log "KEEP=1: 임시 구성을 남김($src, $dst)"; return; fi
  dc "$src" "$src_port" down -v --remove-orphans >/dev/null 2>&1 || true
  dc "$dst" "$dst_port" down -v --remove-orphans >/dev/null 2>&1 || true
  AWBS_STACK="$neg" docker compose -p "$neg" -f "$here/compose.prod.yaml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work/secrets" "$work/cookies" "$work/runner"
  echo "[rehearsal] 임시 구성과 리허설 비밀 파일을 지웠습니다. 기록: $result" >&2
}
trap cleanup EXIT

log "작업 폴더 $work, 이미지 꼬리표 $AWBS_IMAGE_TAG, git $(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo unknown)"
bash "$here/prod-init.sh" >/dev/null

log "1. 원본 구성 기동($src)"
dc "$src" "$src_port" up -d --wait >&2
db_check() { # $1 stack, $2 port — 운영 이미지 안에서 실제 앱 접속을 확인한다.
  local stack="$1" port="$2" svc json user
  json="$(dc "$stack" "$port" exec -T api awbs-entrypoint db-check)" || { log "   실패: 앱 DB 권한 확인($stack) $json"; exit 1; }
  log "   $stack 앱 DB 권한: $json"
  for svc in api worker; do
    # 실행 중인 프로그램(1번 프로세스)의 DB 사용자 이름만 꺼낸다. 비밀번호는 출력하지 않는다.
    user="$(dc "$stack" "$port" exec -T "$svc" sh -c "tr '\\0' '\\n' < /proc/1/environ | sed -n 's|^DATABASE_URL=postgres://\\([^:]*\\):.*|\\1|p'")"
    [[ "$user" == awbs_app_login ]] || { log "   실패: $stack $svc 의 DB 사용자=$user"; exit 1; }
    dc "$stack" "$port" exec -T "$svc" sh -c 'test ! -e /run/secrets/db_password' || { log "   실패: $stack $svc 에 관리자 비밀 파일이 있습니다"; exit 1; }
  done
  log "   $stack api·worker: DB 사용자 awbs_app_login, 관리자 비밀 파일 없음"
}
log "1-1. 앱 DB 권한 확인(원본)"
db_check "$src" "$src_port"

log "2. 시험 자료 넣기(seed demo)"
# seed demo는 DB 주소가 이 컴퓨터(127.0.0.1)일 때만 실행된다(packages/db/src/test-database.ts). 그래서 DB 컨테이너의 네트워크 공간 안에서 돌린다.
docker run --rm --network "container:$src-postgres" -e AWBS_DB_HOST=127.0.0.1 -e AWBS_DB_NAME \
  -v "$work/secrets/db-password:/run/secrets/db_password:ro" -v "$work/secrets/secret-key:/run/secrets/secret_key:ro" \
  "awbs-app:$AWBS_IMAGE_TAG" seed-demo >&2
marker="$(dc "$src" "$src_port" exec -T worker sh -c 'umask 077; d=/home/node/.agentwbs/wbs/rehearsal; mkdir -p "$d"; head -c 65536 /dev/urandom > "$d/marker.bin"; sha256sum "$d/marker.bin" | cut -d" " -f1')"
log "   데이터 파일 표식 sha256=$marker"

mkdir -p "$work/cookies" "$work/api" && chmod 0700 "$work/cookies" "$work/api"
api_snapshot() { # $1 stack, $2 port, $3 저장 폴더 이름
  local stack="$1" port="$2" name="$3" origin="http://127.0.0.1:$2" jar="$work/cookies/$3" link token
  link="$(dc "$stack" "$port" exec -T api awbs-entrypoint auth login-link)"
  token="${link##*#login-token=}"
  curl -fsS -o /dev/null -c "$jar" -H "Origin: $origin" -H 'Content-Type: application/json' \
    --data "{\"method\":\"link\",\"token\":\"$token\"}" "$origin/api/auth/session"
  mkdir -p "$work/api/$name" && chmod 0700 "$work/api/$name"
  local path file
  for path in /api/project /api/schedule /api/gates /api/runner-state '/api/history?limit=100' '/api/proposals?limit=100' \
    '/api/messages?limit=100' '/api/evidence?limit=100' /api/settings/models /api/settings/workflow /api/settings/subagents \
    /api/settings/mail/smtp /api/settings/mail/recipients /api/settings/app-url; do
    file="$work/api/$name/$(printf '%s' "$path" | tr '/?=&' '____').json"
    printf '%s ' "$(curl -sS -b "$jar" -o "$file" -w '%{http_code}' "$origin$path")" >> "$work/api/$name/status.txt"
    echo "$path" >> "$work/api/$name/status.txt"
  done
}
log "3. 원본 API 응답 저장(로그인 링크 → GET 14개)"
api_snapshot "$src" "$src_port" src

log "4. 백업(backup.sh)"
backup="$(AWBS_STACK="$src" bash "$here/backup.sh")"
log "   백업 폴더 $backup"
sed 's/^/   manifest: /' "$backup/manifest.txt" | tee -a "$result" >&2
stat -c '   권한 %a %n' "$backup" "$backup"/* | tee -a "$result" >&2

log "4-1. 없는 이미지 꼬리표로 복원 시도(멈춰야 함)"
set +e
AWBS_STACK="$neg" AWBS_IMAGE_TAG=no-such-tag-m806 bash "$here/restore.sh" "$backup" >"$work/neg.log" 2>&1
neg_code=$?
set -e
sed 's/^/   /' "$work/neg.log" | tee -a "$result" >&2
leftover="$(docker volume ls -q --filter "name=^$neg-" | wc -l)"
[[ "$neg_code" == 6 && "$leftover" == 0 ]] || { log "   실패: 종료 코드 $neg_code, 남은 볼륨 $leftover 개"; exit 1; }
log "   멈춤 확인: 종료 코드 6, 만든 볼륨 0개"

log "4-2. 이미지 ID가 빠진 manifest로 복원 시도(꼬리표 생략, 멈춰야 함)"
noid="$work/backup-noid"
cp -a "$backup" "$noid"
sed -i '/^image_id=/d;/^web_image_id=/d' "$noid/manifest.txt"
set +e
env -u AWBS_IMAGE_TAG AWBS_STACK="$neg" bash "$here/restore.sh" "$noid" >"$work/neg2.log" 2>&1
neg_code=$?
set -e
sed 's/^/   /' "$work/neg2.log" | tee -a "$result" >&2
leftover="$(docker volume ls -q --filter "name=^$neg-" | wc -l)"
[[ "$neg_code" == 6 && "$leftover" == 0 ]] || { log "   실패: 종료 코드 $neg_code, 남은 볼륨 $leftover 개"; exit 1; }
log "   멈춤 확인: 종료 코드 6, 만든 볼륨 0개"
rm -rf "$noid"

log "5. 새 DB에 복원(restore.sh → $dst, 꼬리표는 manifest에서)"
env -u AWBS_IMAGE_TAG AWBS_STACK="$dst" bash "$here/restore.sh" "$backup" 2>&1 | tee -a "$result" >&2

log "6. 대상 앱 기동"
dc "$dst" "$dst_port" up -d --wait >&2
health="$(curl -fsS "http://127.0.0.1:$dst_port/health/db")"
log "   /health/db → $health"

log "6-1. 앱 DB 권한 확인(대상: 역할을 되살린 뒤 migrate가 앱 로그인 비밀번호를 맞춤)"
db_check "$dst" "$dst_port"

log "7. 대조"
got="$(dc "$dst" "$dst_port" exec -T worker sh -c 'sha256sum /home/node/.agentwbs/wbs/rehearsal/marker.bin | cut -d" " -f1')"
[[ "$got" == "$marker" ]] || { log "   실패: 데이터 파일 표식이 다릅니다($got)"; exit 1; }
log "   데이터 파일 표식 같음"
api_snapshot "$dst" "$dst_port" dst
if ! diff -u "$work/api/src/status.txt" "$work/api/dst/status.txt" >&2; then log "   실패: API 응답 코드가 다릅니다"; exit 1; fi
# /api/schedule은 「지금」 시각(at)과 지금 기준 계획 진척률(plannedPct)을 함께 돌려준다. 이 두 값만 빼고 비교한다.
normalize() { node -e '
  const fs = require("fs"); const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const drop = (o) => { if (Array.isArray(o)) o.forEach(drop); else if (o && typeof o === "object") { delete o.plannedPct; Object.values(o).forEach(drop); } };
  if (process.argv[1].endsWith("_api_schedule.json")) { delete v.at; drop(v); }
  console.log(JSON.stringify(v));' "$1"; }
same=0; differ=0
for file in "$work/api/src"/*.json; do
  base="$(basename "$file")"
  if [[ "$(normalize "$file")" == "$(normalize "$work/api/dst/$base")" ]]; then same=$((same + 1)); else differ=$((differ + 1)); log "   다름: $base"; diff <(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")),null,1))' "$file") \
    <(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")),null,1))' "$work/api/dst/$base") | head -20 | tee -a "$result" >&2 || true; fi
done
log "   API 응답 코드: $(tr '\n' ' ' < "$work/api/dst/status.txt")"
log "   API 응답 본문: 같음 $same 개, 다름 $differ 개(/api/schedule은 at·plannedPct를 뺀 비교)"

log "8. 복원한 DB에서 새 변경 시험(트랜잭션 번호·실제 커밋 시각)"
old_epoch="$(sed -n 's/^xid_epoch=//p' "$backup/manifest.txt")"
psql_on "$dst" <<'SQL' >/dev/null
SELECT format('UPDATE %I.%I SET %I = %I WHERE ctid = (SELECT ctid FROM %I.%I LIMIT 1)', n.nspname, c.relname, t.tgargs_first, t.tgargs_first, n.nspname, c.relname)
FROM (SELECT tgrelid, split_part(encode(tgargs, 'escape'), E'\\000', 1) AS tgargs_first FROM pg_trigger
      WHERE tgfoid = 'public.awbs_state_log'::regproc AND tgrelid = 'public.tasks'::regclass LIMIT 1) t
JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
\gexec
SQL
row="$(psql_on "$dst" -tA -F ' ' <<'SQL'
SELECT public.awbs_settle_commits() IS NOT NULL;
SELECT (r.xid::text::bigint >> 32), r.committed_at IS NOT NULL,
       (SELECT count(*) FROM public.commit_real o WHERE (o.xid::text::bigint >> 32) < (r.xid::text::bigint >> 32))
FROM public.commit_real r ORDER BY r.xid DESC LIMIT 1;
SQL
)"
row="$(tail -n1 <<<"$row")"
read -r new_epoch has_time old_rows <<<"$row"
log "   새 변경: epoch=$new_epoch(백업 $old_epoch) 실제 커밋 시각 기록=$has_time 옛 번호 기록 $old_rows 개 유지"
[[ "$new_epoch" == "$((old_epoch + 1))" && "$has_time" == t ]] || { log "   실패: 새 변경의 트랜잭션 번호나 커밋 시각이 기대와 다릅니다"; exit 1; }

log "9. Runner 연결 재현(안내대로: runner:public-key → 나온 ID로 토큰 → heartbeat)"
runner_home="$work/runner/home"
mkdir -p "$runner_home" && chmod 0700 "$work/runner" "$runner_home"
[[ -f "$repo/agent-runner/scripts/runner-public-key.ts" ]] || { log "   실패: runner:public-key 명령이 없습니다(gh-cred 병합 필요)"; exit 1; }
runner_id="$(env -i PATH="$PATH" AWBS_HOME="$runner_home" node "$repo/agent-runner/scripts/runner-public-key.ts" "$work/runner/pub.pem")"
log "   runner:public-key → Runner ID $runner_id, 공개키 파일 $(stat -c '%a' "$work/runner/pub.pem")"
token="$(dc "$dst" "$dst_port" exec -T api awbs-entrypoint auth runner-token "$runner_id" /dev/stdin < "$work/runner/pub.pem")"
old_token="$(dc "$dst" "$dst_port" exec -T api awbs-entrypoint auth runner-token runner-main /dev/stdin < "$work/runner/pub.pem")"
server_epoch="$(psql_on "$dst" -tAc 'select epoch from public.system_state where id=1')"
heartbeat() { # $1 토큰 → HTTP 코드. Runner의 heartbeat 요청과 같은 모양(src/api/runner.ts beat)
  curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $1" -H "x-project-epoch: $server_epoch" -H 'Content-Type: application/json' \
    --data "{\"runnerId\":\"$runner_id\",\"version\":\"0.0.0\",\"epoch\":$server_epoch}" "http://127.0.0.1:$dst_port/api/runner/heartbeat"
}
new_code="$(heartbeat "$token")"
old_code="$(heartbeat "$old_token")"
log "   heartbeat: 이 Runner의 ID로 발급한 토큰 → $new_code, 옛 안내(runner-main) 토큰 → $old_code"
[[ "$new_code" == 204 && "$old_code" == 403 ]] || { log "   실패: heartbeat 결과가 기대(204/403)와 다릅니다"; exit 1; }
# 실제 Runner 프로그램도 잠깐 띄워 세션 시작 보고가 서버에 들어가는지 본다(자동 실행·CLI 갱신은 끈 상태).
set +e
env -i PATH="$PATH" HOME="$HOME" AWBS_HOME="$runner_home" AWBS_URL="http://127.0.0.1:$dst_port" AWBS_RUNNER_TOKEN="$token" AWBS_CLI_UPDATE=0 \
  timeout -s TERM 20 node "$repo/agent-runner/src/main.ts" > "$work/runner/runner.log" 2>&1
set -e
sessions="$(psql_on "$dst" -tAc "select count(*) from public.runner_sessions where runner_id='$runner_id'")"
log "   실제 Runner 20초 실행: 서버의 세션 기록 $sessions 개(runner_id=$runner_id)"
[[ "$sessions" -ge 1 ]] || { log "   실패: Runner 세션이 서버에 기록되지 않았습니다(로그 $work/runner/runner.log)"; exit 1; }
unset token old_token

if ((differ)); then log "결과: 표 지문·데이터 파일·새 변경은 통과, API 본문 $differ 개 다름(위 diff 확인)"; exit 1; fi
log "결과: 통과(표 지문·데이터 파일·API 응답·새 변경·앱 DB 권한·이미지 고정·Runner 연결 모두 정상)"
