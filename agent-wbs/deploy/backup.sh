#!/usr/bin/env bash
# Agent WBS 운영 백업(M8-06). 저장소 맨 위 폴더에서 실행한다.
#   bash agent-wbs/deploy/backup.sh
#
# 만드는 것: $AWBS_PROD_HOME/backups/<UTC 시각>/ (폴더 0700, 파일 0600)
#   db.dump          DB 전체(pg_dump custom 형식)
#   roles.sql        DB 역할(awbs_data_owner·awbs_app 등). 비밀번호 해시는 넣지 않는다(--no-role-passwords)
#   data.tar         데이터 파일(evidence·PDF) 볼륨
#   fingerprint.tsv  표마다 행 수·내용 지문. 복원 뒤 같은지 대조한다(sql/fingerprint.sql)
#   manifest.txt     만든 시각·대상·이미지·커밋·트랜잭션 번호·파일 sha256
#
# 순서와 이유
# 1. api·worker를 잠깐 멈춘다. 왜: DB와 데이터 파일을 같은 순간의 모습으로 뜨고, 아래 2번 뒤에 새 변경이 끼어들지 않게 한다.
# 2. 보고서 이력 정리(awbs_settle_commits)를 한 번 부른다.
#    왜: 실제 커밋 시각(track_commit_timestamp)은 DB 서버 안에만 있고 pg_dump에 담기지 않는다.
#        정리가 그 시각을 commit_real 표에 옮겨 적어야 복원한 DB에서도 보고서의 「그때 상태」가 같다.
# 3. 지문 → pg_dump → 역할 → 데이터 파일 순서로 뜬다.
# 4. 멈췄던 서비스를 다시 켠다(실패해도 켠다).
# 비밀 파일(secrets/)은 백업에 넣지 않는다. 왜: 백업 파일 하나가 새도 암호화한 토큰까지 열리지 않게 한다.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AWBS_STACK="${AWBS_STACK:-awbs-prod}"
home="${AWBS_PROD_HOME:-$HOME/.agentwbs/prod}"
db="${AWBS_DB_NAME:-awbs}"
compose=(docker compose -p "$AWBS_STACK" -f "$here/compose.prod.yaml")
pg="$AWBS_STACK-postgres"

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
psql_db() { docker exec -i "$pg" psql -X -q -v ON_ERROR_STOP=1 -U awbs_owner -d "$db" "$@"; }

if [[ "$(docker inspect -f '{{.State.Running}}' "$pg" 2>/dev/null)" != "true" ]]; then
  echo "DB 컨테이너 $pg 가 켜져 있지 않습니다. 먼저 켜세요: docker compose -p $AWBS_STACK -f agent-wbs/deploy/compose.prod.yaml up -d --wait postgres" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$home/backups/$stamp"
mkdir -p "$home" "$home/backups" && chmod 0700 "$home" "$home/backups"
mkdir -m 0700 "$out"

mapfile -t was_running < <("${compose[@]}" ps --status running --services 2>/dev/null | grep -xE 'api|worker' || true)
restart() {
  if ((${#was_running[@]})); then
    log "멈췄던 서비스를 다시 켭니다: ${was_running[*]}"
    "${compose[@]}" start "${was_running[@]}" >&2 || log "다시 켜기 실패. 직접 실행: docker compose -p $AWBS_STACK -f agent-wbs/deploy/compose.prod.yaml up -d"
  fi
}
trap restart EXIT
if ((${#was_running[@]})); then
  log "쓰기를 멈춥니다: ${was_running[*]}"
  "${compose[@]}" stop "${was_running[@]}" >&2
fi

if [[ "$(psql_db -tAc "select to_regprocedure('public.awbs_settle_commits()') is not null")" == "t" ]]; then
  log "보고서 이력 정리(awbs_settle_commits)"
  psql_db -tAc 'select public.awbs_settle_commits()' >/dev/null
fi
xid="$(psql_db -tAc 'select pg_current_xact_id()::text')"
epoch=$((xid >> 32))

log "표 지문"
psql_db < "$here/sql/fingerprint.sql" > "$out/fingerprint.tsv"
log "DB 덤프(pg_dump)"
docker exec "$pg" pg_dump -U awbs_owner -d "$db" --format=custom --compress=6 > "$out/db.dump"
docker exec "$pg" pg_dumpall -U awbs_owner --roles-only --no-role-passwords > "$out/roles.sql"
# 덤프를 실제로 읽을 수 있는지 바로 확인한다. 왜: 깨진 백업은 복원할 때에야 알게 되면 늦다.
docker exec -i "$pg" pg_restore --list < "$out/db.dump" > /dev/null

image="$(docker inspect -f '{{.Config.Image}}' "$AWBS_STACK-worker" 2>/dev/null || true)"
[[ -n "$image" ]] || image="awbs-app:${AWBS_IMAGE_TAG:-local}"
log "데이터 파일 볼륨($AWBS_STACK-data)"
docker run --rm --network none --user node --entrypoint tar \
  -v "$AWBS_STACK-data:/home/node/.agentwbs:ro" "$image" -C /home/node/.agentwbs -cf - . > "$out/data.tar"

{
  echo "created_utc=$stamp"
  echo "stack=$AWBS_STACK"
  echo "database=$db"
  echo "image=$image"
  echo "image_id=$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || echo unknown)"
  echo "git_commit=$(git -C "$here" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "server_version=$(psql_db -tAc 'show server_version')"
  echo "track_commit_timestamp=$(psql_db -tAc 'show track_commit_timestamp')"
  echo "xid_at_backup=$xid"
  echo "xid_epoch=$epoch"
  echo "tables=$(wc -l < "$out/fingerprint.tsv")"
  (cd "$out" && sha256sum db.dump roles.sql data.tar fingerprint.tsv | sed 's/^/sha256 /')
} > "$out/manifest.txt"
chmod 0600 "$out"/*

log "완료: $out"
ls -l "$out" >&2
echo "$out"
