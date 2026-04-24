#!/usr/bin/env bash
# run-temu.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"

cd "${SCRIPT_DIR}"
./assets/temu -ctrlc ./vmsandbox_console.cfg
