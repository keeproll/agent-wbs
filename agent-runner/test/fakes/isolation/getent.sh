#!/bin/bash
R=__ROOT__
db=$1 key=${2-}
f=$R/etc/$db
[[ -f $f ]] || exit 2
if [[ -z $key ]]; then cat "$f"; exit 0; fi
awk -F: -v k="$key" '$1 == k || $3 == k { print; found = 1 } END { exit found ? 0 : 2 }' "$f"
