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
export AWBS_PROD_HOME="$work" AWBS_DB_NAME=awbs_test_rehearsal AWBS_IMAGE_TAG="${AWBS_IMAGE_TAG:-local}"
result="$work/rehearsal-result.txt"

log() { printf '[rehearsal %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$result" >&2; }
dc() { local stack="$1" port="$2"; shift 2; AWBS_STACK="$stack" AWBS_WEB_PORT="$port" docker compose -p "$stack" -f "$here/compose.prod.yaml" "$@"; }
psql_on() { local stack="$1"; shift; docker exec -i "$stack-postgres" psql -X -q -v ON_ERROR_STOP=1 -U awbs_owner -d "$AWBS_DB_NAME" "$@"; }

for stack in "$src" "$dst"; do
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
  rm -rf "$work/secrets" "$work/cookies"
  echo "[rehearsal] 임시 구성과 리허설 비밀 파일을 지웠습니다. 기록: $result" >&2
}
trap cleanup EXIT

log "작업 폴더 $work, 이미지 꼬리표 $AWBS_IMAGE_TAG, git $(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo unknown)"
bash "$here/prod-init.sh" >/dev/null

log "1. 원본 구성 기동($src)"
dc "$src" "$src_port" up -d --wait >&2
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

log "5. 새 DB에 복원(restore.sh → $dst)"
AWBS_STACK="$dst" bash "$here/restore.sh" "$backup" 2>&1 | tee -a "$result" >&2

log "6. 대상 앱 기동"
dc "$dst" "$dst_port" up -d --wait >&2
health="$(curl -fsS "http://127.0.0.1:$dst_port/health/db")"
log "   /health/db → $health"

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

if ((differ)); then log "결과: 표 지문·데이터 파일·새 변경은 통과, API 본문 $differ 개 다름(위 diff 확인)"; exit 1; fi
log "결과: 통과(표 지문·데이터 파일·API 응답·새 변경 모두 같음/정상)"
