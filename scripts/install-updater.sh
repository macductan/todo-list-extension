#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXT_DIR="${REPO_DIR}/extension"
HOST_SCRIPT="${SCRIPT_DIR}/native-updater.py"
HOST_NAME="com.gittask.updater"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Lỗi: Cần cài đặt python3 để đăng ký Native Messaging Host." >&2
  exit 1
fi

chmod +x "${HOST_SCRIPT}"

python3 - "${HOST_NAME}" "${HOST_SCRIPT}" "${EXT_DIR}" "$@" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import sys

host_name = sys.argv[1]
host_script = sys.argv[2]
ext_dir = sys.argv[3]
cli_args = sys.argv[4:]

def compute_unpacked_extension_id(path_str: str) -> str:
    digest = hashlib.sha256(path_str.encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(ch, 16)) for ch in digest)

def get_browser_config_roots() -> list[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        app_support = home / "Library" / "Application Support"
        candidates = [
            app_support / "Google" / "Chrome",
            app_support / "Google" / "Chrome Beta",
            app_support / "Chromium",
            app_support / "BraveSoftware" / "Brave-Browser",
            app_support / "Microsoft Edge",
        ]
        existing = [p for p in candidates if p.exists()]
        return existing or [app_support / "Google" / "Chrome", app_support / "Chromium"]

    config_home = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
    candidates = [
        config_home / "google-chrome",
        config_home / "google-chrome-beta",
        config_home / "google-chrome-unstable",
        config_home / "chromium",
        config_home / "BraveSoftware" / "Brave-Browser",
        config_home / "microsoft-edge",
        config_home / "vivaldi",
    ]
    existing = [p for p in candidates if p.exists()]
    return existing or [config_home / "google-chrome", config_home / "chromium"]

if "--uninstall" in cli_args:
    removed = []
    for root in get_browser_config_roots():
        target = root / "NativeMessagingHosts" / f"{host_name}.json"
        if target.exists():
            target.unlink()
            removed.append(str(target))
    if removed:
        print("Đã gỡ đăng ký Native Messaging Host:")
        for item in removed:
            print(f"  - {item}")
    else:
        print("Không tìm thấy Native Messaging Host nào để gỡ.")
    sys.exit(0)

ext_ids: list[str] = []
for raw_id in cli_args:
    cleaned = raw_id.strip().lower()
    if not cleaned:
        continue
    if not re.fullmatch(r"[a-p]{32}", cleaned):
        print(
            f"Lỗi: Extension ID không hợp lệ: '{raw_id}' (phải gồm đúng 32 ký tự từ a-p).",
            file=sys.stderr,
        )
        sys.exit(1)
    if cleaned not in ext_ids:
        ext_ids.append(cleaned)

for candidate_path in (os.path.abspath(ext_dir), os.path.realpath(ext_dir)):
    derived_id = compute_unpacked_extension_id(candidate_path)
    if derived_id not in ext_ids:
        ext_ids.append(derived_id)

manifest = {
    "name": host_name,
    "description": "GitTask Sync Native Git Pull Updater",
    "path": host_script,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{eid}/" for eid in ext_ids],
}

written = []
for root in get_browser_config_roots():
    hosts_dir = root / "NativeMessagingHosts"
    hosts_dir.mkdir(parents=True, exist_ok=True)
    target = hosts_dir / f"{host_name}.json"
    target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    written.append(str(target))

print("Đã đăng ký Native Messaging Host thành công!")
print(f"Script thực thi: {host_script}")
print("Allowed Origins:")
for origin in manifest["allowed_origins"]:
    print(f"  - {origin}")
print("Đã ghi cấu hình tại:")
for item in written:
    print(f"  - {item}")
PY
