#!/usr/bin/env bash
set -euo pipefail

usage="用法: lint.sh <requirements.md> | lint.sh --spec <规则文件>..."
[[ $# -ge 1 ]] || { echo "FAIL: $usage"; exit 1; }

fail() {
  echo "FAIL: $1"
  exit 1
}

detail_patterns=(
  '^```'
  '\.(go|ts|tsx|js|jsx|py|rs|java|kt|sql|vue|proto|ya?ml|toml)\b'
  '\b(src|pkg|internal|cmd|lib|app|components|services|handlers|repository|migrations|tests?)/'
  '\b[A-Za-z_][A-Za-z0-9_]*\(\)'
  '^[[:space:]]*(func|function|class|import|package|struct|interface|def)\b'
)

assert_black_box() {
  local file="$1"
  local hits
  hits=$(for p in "${detail_patterns[@]}"; do grep -nE "$p" "$file" || true; done | sort -t: -k1,1n -u)
  if [[ -n "$hits" ]]; then
    printf '%s\n' "$hits"
    fail "$file 含实现细节，规范必须保持黑盒"
  fi
}

lint_spec_file() {
  local file="$1" expected_name="$2"
  [[ -f "$file" ]] || fail "规范文件不存在: $file"
  (( $(grep -c '' "$file") <= 100 )) || fail "$file 超过 100 行"
  local name
  name=$(sed -n '2,6p' "$file" | sed -n 's/^name:[[:space:]]*//p' | head -1)
  [[ "$name" == "$expected_name" ]] || fail "$file 的 frontmatter name 必须为 $expected_name"
  sed -n '2,6p' "$file" | grep -qE '^description:[[:space:]]*\S' || fail "$file 缺少 description"
  local sections
  sections=$(grep -E '^## ' "$file" || true)
  [[ "$sections" == $'## 目的\n## 逻辑\n## 约束\n## 例子\n## 验收' ]] || fail "$file 的章节必须恰好为 目的 / 逻辑 / 约束 / 例子 / 验收"
  assert_black_box "$file"

  local cids acids
  cids=$(grep -oE '^- C-[0-9]+：' "$file" | grep -oE 'C-[0-9]+' || true)
  acids=$(grep -oE '^### AC-[0-9]+' "$file" | grep -oE 'AC-[0-9]+' || true)
  [[ -n "$cids" ]] || fail "$file 至少需要一条 C-n 约束"
  [[ -n "$acids" ]] || fail "$file 至少需要一条 AC-n 验收"
  [[ -z "$(printf '%s\n' "$cids" | sort | uniq -d)" ]] || fail "$file 约束编号重复"
  [[ -z "$(printf '%s\n' "$acids" | sort | uniq -d)" ]] || fail "$file 验收编号重复"

  local refs ref cid acid ac_line
  refs=$(sed -n '/^### AC-[0-9].*←/s/.*←//p' "$file" | grep -oE 'C-[0-9]+' || true)
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    grep -qE "^- ${ref}：" "$file" || fail "$file 的验收回指了未声明的 $ref"
  done <<< "$refs"
  while IFS= read -r cid; do
    [[ -z "$cid" ]] && continue
    grep -qE "^### AC-[0-9]+.*←.*$cid([[:space:],]|$)" "$file" || fail "$file 的 $cid 没有被任何验收覆盖"
  done <<< "$cids"
  while IFS= read -r acid; do
    [[ -z "$acid" ]] && continue
    ac_line=$(grep -m1 -E "^### $acid([[:space:]]|$)" "$file")
    printf '%s\n' "$ac_line" | grep -qE '←[[:space:]]*C-[0-9]+' || fail "$file 的 $acid 必须回指至少一条约束"
  done <<< "$acids"

  local ac_shape
  ac_shape=$(awk '
function check() { if (ac != "" && (!trigger || !given || !when || !then)) print ac }
/^### AC-[0-9]+/ { check(); ac=$2; trigger=given=when=then=0; next }
/^- 触发:/ { trigger=1; next }
/^- Given:/ { given=1; next }
/^- When:/ { when=1; next }
/^- Then:/ { then=1; next }
END { check() }
' "$file")
  [[ -z "$ac_shape" ]] || fail "$file 的验收缺少固定的触发 / Given / When / Then: $ac_shape"
}

if [[ "$1" == "--spec" ]]; then
  shift
  [[ $# -ge 1 ]] || fail "$usage"
  for spec in "$@"; do
    lint_spec_file "$spec" "$(basename "$spec" .md)"
  done
  echo "PASS"
  exit 0
fi

f="$1"
[[ -f "$f" ]] || fail "requirements.md 不存在"
sections=$(grep -oE '^## [0-9]+\.' "$f" || true)
[[ "$sections" == $'## 1.\n## 2.\n## 3.\n## 4.' ]] || fail "requirements.md 必须恰好包含第 1 至第 4 节"

requirement_dir=$(CDPATH= cd -- "$(dirname -- "$f")" && pwd)
spec_dir=$(CDPATH= cd -- "$requirement_dir/../../spec" 2>/dev/null && pwd) || fail "找不到 .pi-spec/spec 目录"
index="$spec_dir/INDEX.md"

changes=$(sed -n '/^## 3\./,/^## 4\./p' "$f" | grep -E '^\| *[a-z0-9-]+/[a-z0-9-]+ *\| *(新增|修改|删除) *\|' || true)
[[ -n "$changes" ]] || fail "第 3 节规范变更表至少需要一行 <域>/<name> | 新增/修改/删除 | 说明"
(( $(printf '%s\n' "$changes" | grep -c .) <= 8 )) || fail "单个需求触及的规范文件不得超过 8 个，需拆成多个需求"

while IFS= read -r row; do
  [[ -z "$row" ]] && continue
  spec_path=$(printf '%s' "$row" | awk -F'|' '{gsub(/^ +| +$/, "", $2); print $2}')
  change=$(printf '%s' "$row" | awk -F'|' '{gsub(/^ +| +$/, "", $3); print $3}')
  spec_file="$spec_dir/$spec_path.md"
  rule_name="${spec_path##*/}"
  case "$change" in
    新增|修改)
      lint_spec_file "$spec_file" "$rule_name"
      [[ -f "$index" ]] || fail "spec/INDEX.md 不存在"
      grep -qF "($spec_path.md)" "$index" || fail "spec/INDEX.md 未收录 $spec_path"
      ;;
    删除)
      [[ ! -e "$spec_file" ]] || fail "标记删除的规范仍然存在: $spec_path"
      if [[ -f "$index" ]] && grep -qF "($spec_path.md)" "$index"; then fail "spec/INDEX.md 仍收录已删除的 $spec_path"; fi
      ;;
  esac
done <<< "$changes"

echo "PASS"
