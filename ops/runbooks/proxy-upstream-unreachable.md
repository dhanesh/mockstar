# Runbook — Proxy returning `502 mockstar_unreachable`

> Trigger: Client gets `502` with body `{"error":"mockstar_unreachable"}`.
> Severity: P3 — dev-side.
> Constraint: RT-8 (mockstar upstream health + diagnostic 502).

## Diagnosis

```bash
mockstar proxy status
```

The `Upstream:` line tells you whether the proxy thinks mockstar is reachable. If it says
`UNREACHABLE`, mockstar is not responding at `mockstarUrl`.

## Common causes + fixes

1. **Mockstar isn't running.** Start it:
   ```bash
   make dev
   # or
   bunx mockstar ./mocks --port 3000
   ```

2. **Wrong port in config.** Check `~/.mockstar/proxy.json` — `mockstarUrl` should match
   the port mockstar is actually listening on.

3. **Mockstar crashed (TN2 tier-2 / tier-3).** Check mockstar's stderr for
   `{"level":"error","event":"process_fault",...}`. The process-level hook exited
   per the crash-only design. Your orchestrator should restart it.

4. **Firewall / sandbox.** On macOS, rarely, an application firewall refuses localhost
   traffic on non-standard ports. Check System Preferences → Security & Privacy → Firewall.

5. **DNS mode vs upstream URL mismatch.** If you set `mockstarUrl: "http://localhost:3000"`
   but dnsmasq is intercepting `localhost`, the proxy's fetch to "localhost" may be
   hijacked. Use `127.0.0.1` explicitly in `mockstarUrl`.

## Verify from the command line

```bash
# Does mockstar respond directly?
curl -v http://127.0.0.1:3000/health
# Does the proxy respond to HTTPS?
curl -v https://api.razorpay.com/health
# Does the proxy's /proxy/metrics show request counts?
curl -H "Authorization: Bearer $MOCKSTAR_ADMIN_TOKEN" https://127.0.0.1/proxy/metrics
```

## Prevention

Start mockstar first, then the proxy. The proxy logs a warning at start time if
mockstar is unreachable but doesn't block — but if mockstar never comes up, every
request 502s.

Consider adding to your dev script:
```bash
bunx mockstar ./mocks --port 3000 &
until curl -sf http://127.0.0.1:3000/health; do sleep 0.2; done
mockstar proxy start
```
