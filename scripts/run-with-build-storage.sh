#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "[BuildStorage] A command is required." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
requested_cache_root="${TELLUS_BUILD_CACHE_ROOT:-$REPO_ROOT/.build-cache}"

resolve_before_create() {
  local unresolved_path="$1"
  local suffix=""
  local parent_path

  while [ ! -e "$unresolved_path" ]; do
    suffix="/$(basename "$unresolved_path")$suffix"
    parent_path="$(dirname "$unresolved_path")"

    if [ "$parent_path" = "$unresolved_path" ]; then
      echo "[BuildStorage] Cannot resolve cache root: $1" >&2
      return 1
    fi

    unresolved_path="$parent_path"
  done

  printf '%s%s\n' "$(cd "$unresolved_path" && pwd -P)" "$suffix"
}

cache_root="$(resolve_before_create "$requested_cache_root")"

case "$cache_root" in
  /tmp|/tmp/*|/private/tmp|/private/tmp/*)
    echo "[BuildStorage] Refusing to use a temporary directory: $cache_root" >&2
    exit 1
    ;;
esac

case "$cache_root" in
  "$REPO_ROOT"/*) ;;
  *)
    echo "[BuildStorage] Cache root must stay inside the repository: $cache_root" >&2
    exit 1
    ;;
esac

mkdir -p "$cache_root"
cache_root="$(cd "$cache_root" && pwd -P)"

export TELLUS_BUILD_CACHE_ROOT="$cache_root"
export TELLUS_BUILD_STORAGE_CONFIGURED=1
export TMPDIR="$cache_root/tmp"
export GRADLE_USER_HOME="$cache_root/gradle"
export YARN_GLOBAL_FOLDER="$cache_root/yarn/global"
export YARN_CACHE_FOLDER="$cache_root/yarn/cache"
export YARN_ENABLE_GLOBAL_CACHE=false
export TELLUS_IOS_DERIVED_DATA_PATH="$cache_root/xcode/DerivedData"
export npm_config_cache="$cache_root/npm"
export UV_CACHE_DIR="$cache_root/uv"
export PIP_CACHE_DIR="$cache_root/pip"
export CARGO_TARGET_DIR="$cache_root/cargo/target"
export ELECTRON_CACHE="$cache_root/electron"
export ELECTRON_BUILDER_CACHE="$cache_root/electron-builder"
export XDG_CACHE_HOME="$cache_root/xdg"

mkdir -p \
  "$TMPDIR" \
  "$GRADLE_USER_HOME" \
  "$YARN_GLOBAL_FOLDER" \
  "$YARN_CACHE_FOLDER" \
  "$TELLUS_IOS_DERIVED_DATA_PATH" \
  "$npm_config_cache" \
  "$UV_CACHE_DIR" \
  "$PIP_CACHE_DIR" \
  "$CARGO_TARGET_DIR" \
  "$ELECTRON_CACHE" \
  "$ELECTRON_BUILDER_CACHE" \
  "$XDG_CACHE_HOME"

exec "$@"
