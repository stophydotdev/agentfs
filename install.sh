#!/bin/sh
set -eu

PACKAGE="@agentfs/cli"

have() {
  command -v "$1" >/dev/null 2>&1
}

node_is_new_enough() {
  have node || return 1
  version=$(node --version 2>/dev/null) || return 1
  version=${version#v}
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  case "$major$minor" in
    "" | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -gt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -ge 12 ]; }
}

if have bun; then
  bun add -g "$PACKAGE"
  bin_dir=$(bun pm bin -g 2>/dev/null) || bin_dir="${BUN_INSTALL:-$HOME/.bun}/bin"
  skills="bunx --bun skills"
elif have npm && node_is_new_enough; then
  npm install -g "$PACKAGE"
  bin_dir="$(npm prefix -g 2>/dev/null)/bin"
  skills="npx -y skills"
else
  echo "agentfs needs Bun (https://bun.sh) or Node 20.12 or newer (https://nodejs.org) to install." >&2
  exit 1
fi

if have agentfs; then
  agentfs --version
else
  printf 'agentfs is installed but not on your PATH. Add it with: export PATH="%s:$PATH"\n' "$bin_dir"
fi

has_agent() {
  for dir in .claude .codex .cursor .gemini .config/opencode; do
    [ -d "$HOME/$dir" ] && return 0
  done
  return 1
}

if has_agent && $skills add stophydotdev/agentfs --skill agentfs -g -y </dev/null >/dev/null 2>&1; then
  echo "Added the agentfs skill for Claude Code, Codex and other agents."
else
  echo "To teach your agents agentfs, run: npx skills add stophydotdev/agentfs -g"
fi

echo
echo "agentfs put <file or folder>   upload and get a link"
echo "agentfs --help                 list every command"
