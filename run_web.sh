#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
	echo "Error: Node.js no está instalado." >&2
	exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
	echo "Error: npm no está instalado." >&2
	exit 1
fi

cd "$BASE_DIR/web"
npm install
npm start