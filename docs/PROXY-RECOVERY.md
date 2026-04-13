# Proxy manual recovery

If `mockstar proxy install` left your system in a weird state and `mockstar proxy uninstall` refuses to proceed (journal corrupt, or specific steps fail), this document walks through manual recovery.

## 1. Remove the dev CA from the trust store

```bash
mkcert -uninstall
```

This is always safe to run — mkcert is itself idempotent. After it succeeds, every leaf cert signed by the dev CA becomes untrusted system-wide.

Verify:
```bash
# macOS
security find-certificate -c "mockstar-dev-ca" /Library/Keychains/System.keychain
# expected: "SecKeychainSearchCopyNext: The specified item could not be found..."
```

## 2. Remove DNS configuration

### macOS (dnsmasq mode)

```bash
# Stop and remove dnsmasq per-host resolver files
sudo rm -f /etc/resolver/*.conf        # or list specific hostnames
brew services stop dnsmasq
```

### Linux (dnsmasq mode)

```bash
sudo systemctl stop dnsmasq.service
sudo systemctl disable dnsmasq.service
sudo rm -f /etc/dnsmasq.d/mockstar.conf
```

### Either platform (hosts-fallback mode)

Edit `/etc/hosts` with sudo. Remove the block delimited by:

```
# BEGIN mockstar-proxy (do not edit)
... hostnames ...
# END mockstar-proxy
```

## 3. Drop the port-443 capability

### Linux

```bash
# Where <path> is the mockstar/bun binary you granted setcap to
sudo setcap -r <path>
```

### macOS

```bash
launchctl unload -w ~/Library/LaunchAgents/com.mockstar.proxy.plist
rm -f ~/Library/LaunchAgents/com.mockstar.proxy.plist
```

## 4. Remove the install state file

```bash
rm -f ~/.mockstar/install-state.json
# Keep ~/.mockstar/proxy.json if you want to preserve your config
```

## 5. Verify clean state

```bash
mockstar proxy status
```

Expected: `CA installed: no`, `Journal: (none)`, no residual entries.

## If you suspect your laptop is compromised

**Do step 1 FIRST** — it instantly revokes every cert the dev CA has ever signed. Then escalate to your security team with details of what you ran and when.

## Still stuck?

- Check `~/Library/Logs/mockstar-proxy.*.log` (macOS) or `journalctl -u dnsmasq` (Linux) for install-time errors.
- File an issue with your `mockstar proxy status` output + the contents of `~/.mockstar/install-state.json` (redact anything sensitive first).
