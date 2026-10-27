#!/usr/bin/env bash
# Installs this repo's Pi resources into the Pi agent directory.
#
# Copies (or symlinks) extensions, skills, prompt templates, themes and plan-flow
# instruction overrides from this repo into ~/.pi/agent, keeping a timestamped
# backup of any file that is replaced.
#
#   ./scripts/install.sh              # copy (default)
#   ./scripts/install.sh --link       # symlink instead of copy (repo stays the source of truth)
#   ./scripts/install.sh --dry-run
#   PI_AGENT_DIR=/path/to/agent ./scripts/install.sh
#
# On a machine without this repo checked out, install it as a Pi package instead:
#   pi-bolt install git:github.com/edubrunaldi/pi-settings
# Do not do both on the same machine: Pi would load the extension twice.
set -euo pipefail

AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LINK=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --link) LINK=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLED=()
SKIPPED=()
WARNINGS=()
FATAL=0

step() { printf '== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }

SETTINGS="$AGENT_DIR/settings.json"
if [ -f "$SETTINGS" ] && grep -q 'pi-settings' "$SETTINGS"; then
  WARNINGS+=("settings.json already references 'pi-settings' as a package; installing the files too would load the extension twice.")
  FATAL=1
fi

install_file() {
  local source="$1" target="$2"
  local rel="${target#"$AGENT_DIR"/}"
  if [ -f "$target" ] && cmp -s "$source" "$target"; then
    SKIPPED+=("$rel"); note "unchanged: $rel"; return
  fi
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] install $rel"; INSTALLED+=("$rel"); return
  fi
  mkdir -p "$(dirname "$target")"
  if [ -f "$target" ]; then
    cp -p "$target" "$target.bak-$STAMP"
    note "backup: $(basename "$target").bak-$STAMP"
  fi
  if [ "$LINK" = 1 ]; then
    ln -sfn "$source" "$target" 2>/dev/null || cp -p "$source" "$target"
    [ -L "$target" ] || WARNINGS+=("symlink not supported here (MSYS/Windows without Developer Mode): copied $rel instead")
  else
    cp -p "$source" "$target"
  fi
  INSTALLED+=("$rel")
}

install_dir() {
  local source="$1" target="$2"
  local rel="${target#"$AGENT_DIR"/}"
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] install $rel/"; INSTALLED+=("$rel/"); return
  fi
  mkdir -p "$(dirname "$target")"
  if [ -e "$target" ] || [ -L "$target" ]; then
    mv "$target" "$target.bak-$STAMP"
    note "backup: $(basename "$target").bak-$STAMP"
  fi
  if [ "$LINK" = 1 ]; then
    ln -sfn "$source" "$target" 2>/dev/null || cp -Rp "$source" "$target"
    [ -L "$target" ] || WARNINGS+=("symlink not supported here (MSYS/Windows without Developer Mode): copied $rel/ instead")
  else
    cp -Rp "$source" "$target"
  fi
  INSTALLED+=("$rel/")
}

step "repo:  $ROOT"
step "agent: $AGENT_DIR"
[ "$LINK" = 1 ] && note "mode: symlink" || note "mode: copy"
[ "$DRY_RUN" = 1 ] || mkdir -p "$AGENT_DIR"

step "extensions"
if [ -d "$ROOT/extensions" ]; then
  for file in "$ROOT/extensions"/*; do
    [ -f "$file" ] || continue
    case "$file" in *.ts|*.js|*.mjs|*.cjs) install_file "$file" "$AGENT_DIR/extensions/$(basename "$file")" ;; esac
  done
  for dir in "$ROOT/extensions"/*/; do
    [ -d "$dir" ] || continue
    if [ -f "$dir/index.ts" ] || [ -f "$dir/index.js" ]; then
      install_dir "${dir%/}" "$AGENT_DIR/extensions/$(basename "${dir%/}")"
    fi
  done
fi

step "skills"
if [ -d "$ROOT/skills" ]; then
  for dir in "$ROOT/skills"/*/; do
    [ -f "${dir}SKILL.md" ] || continue
    install_dir "${dir%/}" "$AGENT_DIR/skills/$(basename "${dir%/}")"
  done
fi

step "prompts"
if [ -d "$ROOT/prompts" ]; then
  for file in "$ROOT/prompts"/*.md; do
    [ -f "$file" ] || continue
    install_file "$file" "$AGENT_DIR/prompts/$(basename "$file")"
  done
fi

step "themes"
if [ -d "$ROOT/themes" ]; then
  for file in "$ROOT/themes"/*.json; do
    [ -f "$file" ] || continue
    install_file "$file" "$AGENT_DIR/themes/$(basename "$file")"
  done
fi

step "plan-flow overrides"
if [ -d "$ROOT/plan-flow" ]; then
  for file in "$ROOT/plan-flow"/*.md; do
    [ -f "$file" ] || continue
    [ "$(basename "$file")" = "README.md" ] && continue
    install_file "$file" "$AGENT_DIR/plan-flow/$(basename "$file")"
  done
fi

step "summary"
printf '   installed: %s, unchanged: %s\n' "${#INSTALLED[@]}" "${#SKIPPED[@]}"
for item in "${INSTALLED[@]:-}"; do [ -n "$item" ] && printf '   + %s\n' "$item"; done
for item in "${WARNINGS[@]:-}"; do [ -n "$item" ] && printf '   ! %s\n' "$item"; done

if [ "$DRY_RUN" = 0 ]; then
  printf '\nRestart Pi or run /reload in an open session.\n'
fi
[ "$FATAL" = 1 ] && exit 1
exit 0
