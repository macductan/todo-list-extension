#!/usr/bin/env python3
"""Chrome Native Messaging Host for GitTask Sync self-updating via git pull."""

import json
import os
from pathlib import Path
import struct
import subprocess
import sys

REPO_DIR = Path(__file__).resolve().parent.parent
MAX_MESSAGE_BYTES = 65536
GIT_TIMEOUT_SECONDS = 30


def read_native_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0 or msg_len > MAX_MESSAGE_BYTES:
        raise ValueError(f"Độ dài message không hợp lệ: {msg_len}")
    payload = sys.stdin.buffer.read(msg_len)
    if len(payload) < msg_len:
        raise ValueError("Payload Native Messaging bị cắt ngắn.")
    return json.loads(payload.decode("utf-8"))


def send_native_message(obj):
    encoded = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def build_git_env():
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    path_parts = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    for extra in ("/usr/local/bin", "/usr/bin", "/bin"):
        if extra not in path_parts:
            path_parts.append(extra)
    env["PATH"] = os.pathsep.join(path_parts)
    return env


def run_git(args):
    return subprocess.run(
        ["git"] + list(args),
        cwd=str(REPO_DIR),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=GIT_TIMEOUT_SECONDS,
        env=build_git_env(),
    )


def handle_ping():
    branch_res = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    commit_res = run_git(["rev-parse", "--short", "HEAD"])
    status_res = run_git(["status", "--porcelain"])

    if branch_res.returncode != 0 or commit_res.returncode != 0:
        details = (branch_res.stderr or commit_res.stderr or branch_res.stdout).strip()[:500]
        return {
            "ok": False,
            "action": "ping",
            "repoDir": str(REPO_DIR),
            "error": "Thư mục không phải là repository Git hợp lệ.",
            "details": details,
        }

    return {
        "ok": True,
        "action": "ping",
        "repoDir": str(REPO_DIR),
        "branch": branch_res.stdout.strip(),
        "commit": commit_res.stdout.strip(),
        "dirty": bool(status_res.stdout.strip()),
    }


def handle_git_pull():
    branch_res = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    before_res = run_git(["rev-parse", "--short", "HEAD"])
    branch = branch_res.stdout.strip() if branch_res.returncode == 0 else "unknown"
    before_commit = before_res.stdout.strip() if before_res.returncode == 0 else ""

    pull_res = run_git(["pull", "--ff-only"])
    if pull_res.returncode != 0:
        details = (pull_res.stderr or pull_res.stdout).strip()[:500]
        return {
            "ok": False,
            "action": "git_pull",
            "branch": branch,
            "beforeCommit": before_commit,
            "error": "Không thể git pull tự động (kiểm tra thay đổi cục bộ hoặc kết nối SSH/mạng).",
            "details": details,
        }

    after_res = run_git(["rev-parse", "--short", "HEAD"])
    after_commit = after_res.stdout.strip() if after_res.returncode == 0 else before_commit

    if before_commit and after_commit and before_commit != after_commit:
        count_res = run_git(["rev-list", "--count", f"{before_commit}..{after_commit}"])
        commits_count = (
            int(count_res.stdout.strip())
            if count_res.returncode == 0 and count_res.stdout.strip().isdigit()
            else 1
        )
        subj_res = run_git(["log", "-1", "--pretty=%s"])
        latest_subject = subj_res.stdout.strip() if subj_res.returncode == 0 else ""
        return {
            "ok": True,
            "action": "git_pull",
            "updated": True,
            "branch": branch,
            "beforeCommit": before_commit,
            "afterCommit": after_commit,
            "commitsCount": commits_count,
            "latestSubject": latest_subject,
        }

    return {
        "ok": True,
        "action": "git_pull",
        "updated": False,
        "branch": branch,
        "beforeCommit": before_commit,
        "afterCommit": after_commit,
    }


def main():
    try:
        message = read_native_message()
    except Exception as exc:
        send_native_message({"ok": False, "error": f"Lỗi đọc yêu cầu: {exc}"})
        return

    if not isinstance(message, dict):
        send_native_message({"ok": False, "error": "Yêu cầu không hợp lệ."})
        return

    action = message.get("action")
    try:
        if action == "ping":
            send_native_message(handle_ping())
        elif action == "git_pull":
            send_native_message(handle_git_pull())
        else:
            send_native_message({"ok": False, "error": f"Action không được hỗ trợ: {action}"})
    except subprocess.TimeoutExpired:
        send_native_message(
            {
                "ok": False,
                "action": action,
                "error": "Lệnh git pull bị quá thời gian chờ (30s). Vui lòng kiểm tra kết nối mạng/SSH.",
            }
        )
    except Exception as exc:
        send_native_message(
            {
                "ok": False,
                "action": action,
                "error": "Lỗi thực thi Native Updater.",
                "details": str(exc)[:500],
            }
        )


if __name__ == "__main__":
    main()
