#!/bin/sh
set -eu
root=$1
role=$2
case "$role" in live|saved|other) ;; *) exit 2 ;; esac
[ -f "$root/fixture-owner.json" ] || exit 2
printf '\033[2J\033[H'
i=1
while [ "$i" -le 80 ]; do
  printf 'SCROLL needle %s %03d | literal [x].* | tab\tend\n' "$role" "$i"
  i=$((i + 1))
done
printf 'NORMAL needle %s | Unicode: İ 😀 | trailing spaces   \n' "$role"
printf '\033[?1049h\033[2J\033[H'
printf 'SCREEN needle %s\nLiteral [x].* stays literal\n' "$role"
printf '%s\n' "READY $role"
refreshed=0
while :; do
  if [ "$refreshed" -eq 0 ] && [ -f "$root/refresh-$role" ]; then
    printf 'REFRESH needle %s\n' "$role"
    refreshed=1
  fi
  /bin/sleep 0.1
done
