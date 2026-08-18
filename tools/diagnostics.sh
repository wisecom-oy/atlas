#!/usr/bin/env bash
#
# Dumps the environment facts a maintainer needs to act on a bug report.
#
# Paste the output into a GitHub issue. Safe to paste: this script reports
# whether configuration exists, never what it contains. No tenant ID, client
# secret, passphrase, or storage key is ever printed.
#
# macOS and Linux. Written for bash 3.2 (the version macOS ships).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Prints "value" or "not installed" without aborting on a missing binary.
version_of() {
  local binary="$1"
  shift
  if command -v "$binary" >/dev/null 2>&1; then
    "$binary" "$@" 2>/dev/null | head -1
  else
    echo "not installed"
  fi
}

os_name() {
  case "$(uname -s)" in
    Darwin)
      if command -v sw_vers >/dev/null 2>&1; then
        echo "macOS $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
      else
        echo "macOS"
      fi
      ;;
    Linux)
      if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        echo "${PRETTY_NAME:-${NAME:-Linux}}"
      else
        echo "Linux"
      fi
      ;;
    *) uname -s ;;
  esac
}

atlas_version() {
  if [ -r packages/cli/package.json ] && command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('./packages/cli/package.json').version)" 2>/dev/null
  elif command -v atlas >/dev/null 2>&1; then
    atlas --version 2>/dev/null | head -1
  else
    echo "unknown"
  fi
}

git_commit() {
  git rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

git_state() {
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "dirty"
  else
    echo "clean"
  fi
}

# Reports existence only. Reading these files would mean printing secrets.
present() {
  if [ -e "$1" ]; then echo "present"; else echo "not found"; fi
}

echo "Environment"
echo "-----------"
echo "OS: $(os_name)"
echo "Kernel: $(uname -r)"
echo "Arch: $(uname -m)"
echo "Node: $(version_of node --version)"
echo "pnpm: $(version_of pnpm --version)"
echo "Atlas: $(atlas_version)"
echo "Git branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo "Git commit: $(git_commit) ($(git_state))"
# "Docker version 29.4.0, build 9d7ad9f" -> "29.4.0"
echo "Docker: $(version_of docker --version | sed -E 's/^Docker version ([^,]+).*/\1/')"

# Atlas merges configuration from four sources, later winning over earlier, so
# "which sources exist" is usually the first question a config bug raises.
echo ""
echo "Config sources"
echo "--------------"
echo "atlas.config.json: $(present atlas.config.json)"
echo "~/.atlas/config.json: $(present "$HOME/.atlas/config.json")"
echo "~/.atlas/config.enc: $(present "$HOME/.atlas/config.enc")"
echo ".env: $(present .env)"

set_vars=""
for var in ATLAS_TENANT_ID ATLAS_CLIENT_ID ATLAS_CLIENT_SECRET ATLAS_ENCRYPTION_PASSPHRASE \
  ATLAS_S3_ENDPOINT ATLAS_S3_REGION ATLAS_S3_ACCESS_KEY ATLAS_S3_SECRET_KEY; do
  eval "value=\${$var:-}"
  if [ -n "$value" ]; then
    set_vars="$set_vars $var"
  fi
done
if [ -n "$set_vars" ]; then
  echo "ATLAS_* env vars set:$set_vars"
else
  echo "ATLAS_* env vars set: none"
fi

# The endpoint is non-secret (the CLI's own "config list" shows it unmasked) and
# it separates AWS from MinIO/Wasabi behaviour, which most storage bugs hinge on.
if [ -n "${ATLAS_S3_ENDPOINT:-}" ]; then
  echo "ATLAS_S3_ENDPOINT: $ATLAS_S3_ENDPOINT"
fi

echo ""
echo "No secret values are printed above. Review before posting if your storage"
echo "endpoint is a private hostname you would rather not disclose."
