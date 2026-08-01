#!/bin/sh
# PreToolUse:Write , refuses a new migration whose NNN_ prefix is already taken.
#
# CLAUDE.md documents this footgun: runMigrations() sorts by full filename, so two files
# sharing a prefix have incidental relative order. 037_taxes_category.sql and an earlier
# draft of 039 already collided this way. This turns the documented warning into a wall.

payload=$(cat)
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""' 2>/dev/null)

case "$file" in
  */server/src/db/migrations/*.sql) ;;
  *) exit 0 ;;
esac

# Editing an existing migration is fine; only creation is guarded.
[ -f "$file" ] && exit 0

base=$(basename "$file")
num=$(printf '%s' "$base" | sed -n 's/^\([0-9][0-9][0-9]\)_.*/\1/p')
[ -n "$num" ] || exit 0

dir=$(dirname "$file")
existing=$(ls "$dir"/"$num"_*.sql 2>/dev/null)

if [ -n "$existing" ]; then
  highest=$(ls "$dir"/[0-9][0-9][0-9]_*.sql 2>/dev/null \
    | xargs -n1 basename 2>/dev/null \
    | sed -n 's/^\([0-9][0-9][0-9]\)_.*/\1/p' | sort -n | tail -1)
  next=$(printf '%03d' $((10#$highest + 1)))
  {
    echo "Blocked: migration prefix $num is already used by:"
    printf '%s\n' "$existing"
    echo
    echo "runMigrations() sorts by full filename, so a duplicate prefix gets incidental"
    echo "relative order. 037 and an early draft of 039 collided exactly this way."
    echo "Highest existing is $highest , use ${next}_ instead."
  } >&2
  exit 2
fi

exit 0
