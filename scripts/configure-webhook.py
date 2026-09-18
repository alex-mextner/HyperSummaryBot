#!/usr/bin/env python3
"""Configure the existing Telegram webhook secret without printing credentials.
Run on the authorized deployment host: python3 scripts/configure-webhook.py --env .env
Does not drop pending updates or change the configured webhook destination.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import urllib.error
import urllib.parse
import urllib.request


def api(token, method, data):
    request = urllib.request.Request("https://api.telegram.org/bot" + token + "/" + method,
        data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
    except (OSError, ValueError):
        raise RuntimeError("Telegram webhook configuration request failed; credentials suppressed") from None
    if not result.get("ok"):
        raise RuntimeError("Telegram rejected webhook configuration; credentials suppressed")
    return result["result"]


def atomic_write(path, text):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".webhook-config-")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", type=Path, default=Path(".env"))
    args = parser.parse_args()
    path = args.env.resolve()
    original = path.read_text()
    values = {}
    for line in original.splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip(chr(34) + chr(39))
    token, destination = values.get("BOT_TOKEN"), values.get("WEBHOOK_URL")
    if not token or not destination or urllib.parse.urlsplit(destination).scheme != "https":
        raise RuntimeError("BOT_TOKEN and an HTTPS WEBHOOK_URL are required")
    current = api(token, "getWebhookInfo", {})
    if current.get("url") not in ("", destination):
        raise RuntimeError("Live webhook destination differs from configuration; reconcile first")
    secret = values.get("WEBHOOK_SECRET") or secrets.token_urlsafe(32)
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", secret):
        raise RuntimeError("Configured WEBHOOK_SECRET is not valid")
    lines = [line for line in original.splitlines() if not re.match(r"^\s*WEBHOOK_SECRET=", line)]
    updated = "\n".join(lines + ["WEBHOOK_SECRET=" + secret]) + "\n"
    atomic_write(path, updated)
    try:
        payload = {"url": destination, "secret_token": secret, "drop_pending_updates": False}
        if current.get("allowed_updates") is not None: payload["allowed_updates"] = current["allowed_updates"]
        if current.get("max_connections"): payload["max_connections"] = current["max_connections"]
        api(token, "setWebhook", payload)
    except Exception:
        atomic_write(path, original)
        raise
    print(json.dumps({"webhook_configured": True, "secret_created": not bool(values.get("WEBHOOK_SECRET")), "pending_updates_dropped": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ": " + str(error))
        raise SystemExit(1)
