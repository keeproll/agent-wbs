#!/usr/bin/env bash
# Agent WBS 복원(M8-06). 백업 폴더 하나를 「새」 DB·데이터 볼륨에 되살린다. 저장소 맨 위 폴더에서 실행한다.
#   AWBS_STACK=<대상 이름> bash agent-wbs/deploy/restore.sh <백업 폴더>
#
# 안전 규칙: 대상의 DB 볼륨(<대상>-pgdata)이나 데이터 볼륨(<대상>-data)이 이미 있으면 멈춘다.
#   왜: 복원은 덮어쓰기가 아니라 「빈 곳에 새로 만들기」여야 실수로 지금 데이터를 지우지 않는다.
#   운영 이름(awbs-prod)으로 되살려야 한다면 옛 볼륨을 owner가 직접 지운 뒤 실행한다(docs/ops/operations.md 「복원」).
# 비밀 파일은 백업에 없다. 대상 AWBS_PROD_HOME/secrets의 secret-key가 백업한 쪽과 같아야 암호화한 토큰을 열 수 있다.
#
# 순서와 이유
# 1. 파일 sha256을 manifest와 대조한다. 왜: 옮기다 깨진 파일로 복원하지 않는다.
# 2. 빈 DB 서버를 처음 띄웠다가 멈추고, 트랜잭션 번호의 epoch(위쪽 32비트)를 백업 쪽보다 1 크게 올린다(pg_resetwal -e).
#    왜: 보고서 이력은 트랜잭션 번호(xid8)로 커밋 시각을 찾는다(commit_log·commit_real·state_log).
#        새 DB 서버는 번호를 작은 값부터 다시 매기므로, 그대로 두면 새 변경이 백업 안의 옛 번호와 겹쳐
#        새 변경의 커밋 시각이 기록되지 않거나 옛 시각으로 읽힌다. epoch를 올리면 새 번호가 언제나 옛 번호보다 크다.
# 3. 역할(roles.sql) → DB(pg_restore, 한 트랜잭션) → 지문 대조 → 데이터 파일 순서로 되살린다.
# 4. api·worker는 켜지 않는다. 켜는 명령은 마지막에 보여 준다.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup="${1:?사용법: AWBS_STACK=<대상 이름> bash agent-wbs/deploy/restore.sh <백업 폴더>}"
backup="$(cd "$backup" && pwd)"
export AWBS_STACK="${AWBS_STACK:-awbs-prod}"
compose=(docker compose -p "$AWBS_STACK" -f "$here/compose.prod.yaml")
pg="$AWBS_STACK-postgres"

log() { printf '[restore %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
field() { sed -n "s/^$1=//p" "$backup/manifest.txt" | head -n1; }

[[ -r "$backup/manifest.txt" ]] || { echo "manifest.txt가 없습니다: $backup" >&2; exit 2; }
db="$(field database)"
export AWBS_DB_NAME="${AWBS_DB_NAME:-$db}"
if [[ "$AWBS_DB_NAME" != "$db" ]]; then echo "AWBS_DB_NAME($AWBS_DB_NAME)이 백업의 DB 이름($db)과 다릅니다." >&2; exit 2; fi
epoch="$(field xid_epoch)"
[[ "$epoch" =~ ^[0-9]+$ ]] || { echo "manifest의 xid_epoch가 없습니다." >&2; exit 2; }

log "파일 sha256 대조"
(cd "$backup" && sed -n 's/^sha256 //p' manifest.txt | sha256sum --check --quiet)

for volume in "$AWBS_STACK-pgdata" "$AWBS_STACK-data"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "볼륨 $volume 이(가) 이미 있습니다. 복원은 빈 곳에만 합니다(이 스크립트 머리말 「안전 규칙」)." >&2
    exit 3
  fi
done

log "빈 DB 서버 준비"
"${compose[@]}" up -d --wait postgres >&2
fresh="$(docker exec "$pg" psql -X -tA -U awbs_owner -d postgres -c 'select pg_current_xact_id()::text')"
log "새 서버의 지금 트랜잭션 번호 $fresh, 백업 순간의 번호 $(field xid_at_backup)"
"${compose[@]}" stop postgres >&2
new_epoch=$((epoch + 1))
log "트랜잭션 번호 epoch를 $new_epoch 로 올림(백업 쪽 $epoch)"
"${compose[@]}" run --rm --no-deps -T --user postgres --entrypoint pg_resetwal postgres \
  -e "$new_epoch" /var/lib/postgresql/data >&2
"${compose[@]}" up -d --wait postgres >&2

psql_to() { local target="$1"; shift; docker exec -i "$pg" psql -X -q -v ON_ERROR_STOP=1 -U awbs_owner -d "$target" "$@"; }

log "역할 되살리기"
# awbs_owner는 새 서버를 만들 때 이미 생겼으므로(POSTGRES_USER) 그 줄만 뺀다.
grep -vE '^(CREATE|ALTER) ROLE awbs_owner( |;)' "$backup/roles.sql" | psql_to postgres >&2

log "DB 되살리기(pg_restore)"
docker exec -i "$pg" pg_restore -U awbs_owner -d "$db" --exit-on-error --single-transaction < "$backup/db.dump"
psql_to "$db" -c 'ANALYZE' >&2

log "표 지문 대조"
psql_to "$db" < "$here/sql/fingerprint.sql" > "$backup/fingerprint.restored.tsv"
if ! diff -u "$backup/fingerprint.tsv" "$backup/fingerprint.restored.tsv" >&2; then
  echo "복원한 표 내용이 백업과 다릅니다(위 diff). 대상 볼륨을 지우고 원인을 확인하세요." >&2
  exit 4
fi
log "표 $(wc -l < "$backup/fingerprint.tsv")개 행 수·지문 모두 같음"

check="$(psql_to "$db" -tAc "select pg_current_xact_id() > greatest(
  coalesce((select max(xid) from public.commit_log), '0'::xid8),
  coalesce((select max(xid) from public.commit_real), '0'::xid8),
  coalesce((select max(xid) from public.state_log), '0'::xid8),
  coalesce((select max(xid) from public.global_log), '0'::xid8))" 2>/dev/null || echo skip)"
case "$check" in
  t) log "새 트랜잭션 번호가 백업 안의 모든 번호보다 큼" ;;
  skip) log "보고서 이력 표가 없어 트랜잭션 번호 확인을 건너뜀" ;;
  *) echo "새 트랜잭션 번호가 백업 안의 번호보다 크지 않습니다. 복원을 쓰지 마세요." >&2; exit 5 ;;
esac

log "데이터 파일 되살리기($AWBS_STACK-data)"
# compose로 실행해야 볼륨이 이 구성 소속으로 만들어진다. 비어 있는 볼륨을 처음 붙이면 이미지 폴더의 소유자(node)를 이어받는다.
"${compose[@]}" run --rm --no-deps -T --entrypoint tar worker -C /home/node/.agentwbs -xf - < "$backup/data.tar"
chmod 0600 "$backup/fingerprint.restored.tsv"

log "복원 완료. 앱 켜기:"
echo "AWBS_STACK=$AWBS_STACK docker compose -p $AWBS_STACK -f agent-wbs/deploy/compose.prod.yaml up -d --wait" >&2
