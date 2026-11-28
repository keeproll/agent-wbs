#!/usr/bin/env bash
# 운영에서 쓸 이미지 꼬리표를 정한다(M8-06). 두 이미지가 이 PC에 있을 때만 $AWBS_PROD_HOME/deploy.env에 적는다.
#   bash agent-wbs/deploy/set-image.sh <꼬리표>
# 그 뒤 모든 compose 명령에 --env-file "$AWBS_PROD_HOME/deploy.env"를 붙인다(docs/ops/operations.md 4장).
# 왜 파일에 적나: 명령마다 꼬리표를 손으로 붙이면 한 번만 빠뜨려도 다른 이미지로 뜰 수 있다.
set -euo pipefail
umask 077

tag="${1:?사용법: bash agent-wbs/deploy/set-image.sh <꼬리표>}"
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "꼬리표 형식이 잘못되었습니다: $tag" >&2; exit 2; }
home="${AWBS_PROD_HOME:-$HOME/.agentwbs/prod}"
for image in "awbs-app:$tag" "awbs-web:$tag"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "이미지 $image 가 없습니다. 먼저 build.sh로 만드세요." >&2; exit 3; }
done
mkdir -p "$home" && chmod 0700 "$home"
tmp="$(mktemp "$home/deploy.env.XXXXXX")"
printf 'AWBS_IMAGE_TAG=%s\n' "$tag" > "$tmp"
chmod 0600 "$tmp"
mv "$tmp" "$home/deploy.env"
echo "정함: $home/deploy.env → AWBS_IMAGE_TAG=$tag"
