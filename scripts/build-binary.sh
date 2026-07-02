#!/usr/bin/env bash
# Build the notes-summarizer Executa as an Anna binary-distribution archive.
#
# Default: detect the current machine's platform key and build one archive
# runnable on this machine. `--all` cross-compiles every supported platform.
#
# Archive layout (per https://staging.anna.partners/developers/tools/executa-binary):
#   <archive root>
#   ├── manifest.json                      # pins name/version + runtime.binary
#   └── bin/tool-dev-mini-notes-summarizer[.exe]   # entrypoint
#
# Platform keys / asset formats:
#   darwin-arm64    → .tar.gz
#   darwin-x86_64   → .tar.gz
#   windows-x86_64  → .zip
#   linux-x86_64    → .tar.gz (extra, for CI smoke tests)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT/executas/notes-summarizer"
DIST="$ROOT/dist"
TOOL_ID="tool-dev-mini-notes-summarizer"
NAME="mini-notes-summarizer"
VERSION="1.0.0"

SUPPORTED=(darwin-arm64 darwin-x86_64 windows-x86_64 linux-x86_64)

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    MINGW* | MSYS* | CYGWIN*) os="windows" ;;
    *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch="arm64" ;;
    x86_64 | amd64) arch="x86_64" ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os}-${arch}"
}

goos_for() { case "$1" in darwin-*) echo darwin ;; windows-*) echo windows ;; linux-*) echo linux ;; esac; }
goarch_for() { case "$1" in *-arm64) echo arm64 ;; *-x86_64) echo amd64 ;; esac; }

write_manifest() {
  local dest="$1"
  cat > "$dest" <<EOF
{
  "name": "${TOOL_ID}",
  "version": "${VERSION}",
  "runtime": {
    "binary": {
      "entrypoint": {
        "default": "bin/${TOOL_ID}",
        "windows-x86_64": "bin/${TOOL_ID}.exe",
        "windows-arm64": "bin/${TOOL_ID}.exe"
      },
      "permissions": {
        "bin/${TOOL_ID}": "0o755"
      }
    }
  }
}
EOF
}

build_one() {
  local platform="$1"
  local goos goarch ext=""
  goos="$(goos_for "$platform")"
  goarch="$(goarch_for "$platform")"
  [[ "$goos" == "windows" ]] && ext=".exe"

  local stage="$DIST/stage/$platform"
  rm -rf "$stage"
  mkdir -p "$stage/bin"

  echo "▸ building $platform (GOOS=$goos GOARCH=$goarch)"
  (cd "$PLUGIN_DIR" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w" -o "$stage/bin/${TOOL_ID}${ext}" .)

  write_manifest "$stage/manifest.json"
  chmod 0755 "$stage/bin/${TOOL_ID}${ext}"

  mkdir -p "$DIST"
  local asset
  if [[ "$goos" == "windows" ]]; then
    asset="$DIST/${NAME}-${platform}.zip"
    rm -f "$asset"
    (cd "$stage" && zip -q -r "$asset" manifest.json bin)
  else
    asset="$DIST/${NAME}-${platform}.tar.gz"
    rm -f "$asset"
    tar -czf "$asset" -C "$stage" manifest.json bin
  fi
  echo "  → $asset"
}

smoke_test() {
  local platform="$1"
  local host_platform
  host_platform="$(detect_platform)"
  if [[ "$platform" != "$host_platform" ]]; then
    echo "▸ skipping runtime smoke test for $platform (host is $host_platform)"
    return 0
  fi
  local bin="$DIST/stage/$platform/bin/${TOOL_ID}"
  echo "▸ smoke test: describe over JSON-RPC"
  local out
  out="$(echo '{"jsonrpc":"2.0","id":1,"method":"describe"}' | "$bin" 2>/dev/null)"
  echo "$out" | grep -q "\"name\":\"${TOOL_ID}\"" \
    && echo "  ✓ describe returned manifest for ${TOOL_ID}" \
    || { echo "  ✗ describe smoke test failed: $out" >&2; exit 1; }
}

main() {
  local targets=()
  if [[ "${1:-}" == "--all" ]]; then
    targets=("${SUPPORTED[@]}")
  elif [[ -n "${1:-}" ]]; then
    targets=("$1")
  else
    targets=("$(detect_platform)")
  fi

  for t in "${targets[@]}"; do
    [[ " ${SUPPORTED[*]} " == *" $t "* ]] || { echo "unknown platform key: $t" >&2; exit 1; }
    build_one "$t"
    smoke_test "$t"
  done

  echo
  echo "done. archives in $DIST/:"
  ls -lh "$DIST" | grep -E '\.(tar\.gz|zip)$' || true
}

main "$@"
