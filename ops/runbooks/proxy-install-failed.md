# Runbook — `mockstar proxy install` failed partway

> Trigger: `mockstar proxy install` exited non-zero; some mutations succeeded, some didn't.
> Severity: P3 — dev blocker, not production.
> Constraint: RT-7 (journaled install + LIFO rollback), U1 (atomic install).

## 1. What likely happened

The install journal (`~/.mockstar/install-state.json`) records each mutation before executing it. On any failure, `atomicInstall` is supposed to walk the journal LIFO and reverse each recorded step. If you see the error message *"Mutations rolled back (atomic install)"* — rollback worked; the system is clean; re-run install after fixing the root cause.

If rollback itself failed — you'll see `[reverse N] FAILED:` lines. Proceed to step 3.

## 2. Read the journal

```bash
cat ~/.mockstar/install-state.json
```

Each line is a JSON object with `step`, `action`, `reverseCommand`. Identify:
- Which step failed to apply (last `action` with no corresponding success message).
- Which reverses, if any, failed.

## 3. Run uninstall to retry reverses

```bash
mockstar proxy uninstall
```

Reverse functions are idempotent — already-reversed steps are no-ops; only remaining forward mutations get reversed.

If `uninstall` reports `Journal corrupt`, follow `docs/PROXY-RECOVERY.md` for manual recovery.

## 4. Common root causes + fixes

| Symptom | Cause | Fix |
|---|---|---|
| `mkcert -install` failed | mkcert not on PATH | `brew install mkcert` / `apt install mkcert libnss3-tools` |
| `mkcert -install` succeeded but trust store mutation refused | Managed MDM policy | Install aborts with MDM error; coordinate with IT or use `--dns-mode=hosts` |
| `setcap` failed on Linux | libcap-bin not installed | `sudo apt install libcap2-bin` |
| `launchctl load` failed on macOS | plist XML invalid | Inspect `~/Library/LaunchAgents/com.mockstar.proxy.plist`; re-run install after fixing |
| `brew services start dnsmasq` failed | dnsmasq not installed | `brew install dnsmasq`; then retry install |
| Port 443 bind refused | Another process is holding it | `sudo lsof -i :443`; stop culprit; retry |
| `/etc/resolver/<host>` write refused | `/etc/resolver` not writable even with sudo | On some macOS variants this directory doesn't auto-create; `sudo mkdir -p /etc/resolver` |

## 5. Post-incident

If the failure was predictable (missing mkcert, missing dnsmasq, etc.), consider:
- Updating the install output's pre-flight check to detect it explicitly.
- Adding a test case in `tests/proxy-env-detector.test.ts`.
- Filing an issue with reproduction steps.
