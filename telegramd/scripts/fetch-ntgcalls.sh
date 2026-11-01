#!/usr/bin/env bash
# Fetch the pinned prebuilt ntgcalls (LGPL-3.0, https://github.com/pytgcalls/ntgcalls)
# into telegramd/ntg/ (header + libntgcalls.so + licence files), verified by sha256.
# telegramd links it dynamically; it is never committed to this repository.
set -euo pipefail
VERSION=v3.0.5
ZIP_SHA=a6430d968db2b5c273784ede0b8c32f12a55ba89151d3d217c9396397ea1beb3
SO_SHA=c65af3126092a6a496620e6335731ec5a862b4c4e39cfea1248ee7cfa1138534
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/ntg.zip" "https://github.com/pytgcalls/ntgcalls/releases/download/$VERSION/ntgcalls.linux-x86_64-shared_libs.zip"
echo "$ZIP_SHA  $tmp/ntg.zip" | sha256sum --quiet --check
rm -rf "$here/ntg"; mkdir -p "$here/ntg"
unzip -q "$tmp/ntg.zip" -d "$here/ntg"
echo "$SO_SHA  $here/ntg/lib/libntgcalls.so" | sha256sum --quiet --check
echo "ntgcalls $VERSION in $here/ntg (sha256 verified)"
