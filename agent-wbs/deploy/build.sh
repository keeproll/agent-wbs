#!/usr/bin/env bash
# 운영 이미지 두 개(awbs-app:<꼬리표>, awbs-web:<꼬리표>)를 지금 커밋으로 만든다(M8-06).
#   bash agent-wbs/deploy/build.sh            # 꼬리표 = 지금 커밋의 짧은 해시
#   bash agent-wbs/deploy/build.sh <꼬리표>    # 꼬리표를 직접 정할 때
# 커밋하지 않은 변경이 있으면 멈춘다. 왜: 꼬리표(커밋 해시)와 이미지 내용이 달라지면 되돌릴 때 어느 코드인지 알 수 없다.
# 이 스크립트는 이미지만 만든다. 운영에서 쓸 꼬리표는 set-image.sh로 따로 정한다.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
context="$(cd "$here/.." && pwd)"
if [[ -n "$(git -C "$context" status --porcelain -- . 2>/dev/null)" ]]; then
  echo "agent-wbs 폴더에 커밋하지 않은 변경이 있습니다. 커밋한 뒤 다시 실행하세요." >&2
  exit 2
fi
tag="${1:-$(git -C "$context" rev-parse --short HEAD)}"
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "꼬리표 형식이 잘못되었습니다: $tag" >&2; exit 2; }

docker build -f "$here/Dockerfile" --target app -t "awbs-app:$tag" --label "org.agentwbs.commit=$(git -C "$context" rev-parse HEAD)" "$context" >&2
docker build -f "$here/Dockerfile" --target web -t "awbs-web:$tag" --label "org.agentwbs.commit=$(git -C "$context" rev-parse HEAD)" "$context" >&2
echo "만듦: awbs-app:$tag, awbs-web:$tag" >&2
echo "$tag"
