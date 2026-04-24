#!/usr/bin/env bash
# run-browser.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"

cd "${SCRIPT_DIR}"
npm install
npm run dev
