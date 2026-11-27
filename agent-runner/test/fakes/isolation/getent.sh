#!/bin/bash
R=__ROOT__
db=$1 key=${2-}
f=$R/etc/$db
[[ -f $f ]] || exit 2
if [[ -z $key ]]; then cat "$f"; exit 0; fi
# hosts는 「주소 이름...」 모양(공백 구분)이다.
if [[ $db == hosts ]]; then awk -v k="$key" '{ for (i = 2; i <= NF; i++) if ($i == k) { print; found = 1 } } END { exit found ? 0 : 2 }' "$f"; exit; fi
awk -F: -v k="$key" '$1 == k || $3 == k { print; found = 1 } END { exit found ? 0 : 2 }' "$f"
