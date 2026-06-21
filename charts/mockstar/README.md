# mockstar — Helm chart

> Satisfies: RT-10 (Helm OCI push), RT-11 (labeled-ConfigMap tenant pattern), RT-12 (probes + metrics).

Deploys the **mockstar mock + webhook server** for mocking internal/external APIs
and webhooks in **non-production** environments. Secure-by-default and hardened to
a production bar (read-only root FS, non-root, dropped capabilities, probes,
resource limits).

> The TLS-intercepting pass-through **proxy is intentionally NOT deployed** by this
> chart — no MITM CA, no tier1-proxy. This chart ships the mock + webhook server only.

Install from OCI:

```bash
helm install mockstar oci://ghcr.io/dhanesh/charts/mockstar \
  --version 0.1.0 \
  --namespace mockstar --create-namespace
```

## ⚠️ Single-replica by design

mockstar keeps three things **in-memory and per-pod**:

1. the request/response **journal** (replay + assertions),
2. the active-**scenario** state machine (per tenant), and
3. the **webhook retry queue**.

None of these are shared across replicas. The chart therefore:

- defaults to **`replicaCount: 1`**, and
- uses the **`Recreate`** deployment strategy (no rolling surge — we never run two
  stateful pods at once, even briefly during an upgrade).

**Scaling `replicaCount > 1` splits scenario / journal / webhook-queue state across
pods** — a scenario switch lands on one pod, journal reads on another, webhook
retries scatter. Don't scale beyond 1 unless you front the Service with sticky
sessions *and* accept inconsistent state. The `Recreate` strategy means each
`helm upgrade` has a brief outage window, which is acceptable for a non-prod mock
server.

## Security posture (secure-by-default)

| Control | Default |
|---|---|
| Pod `runAsNonRoot` / `runAsUser` | `true` / `10001` |
| Container `readOnlyRootFilesystem` | `true` (writable paths backed by emptyDir) |
| `allowPrivilegeEscalation` | `false` |
| `capabilities.drop` | `ALL` |
| `seccompProfile` | `RuntimeDefault` |
| `automountServiceAccountToken` | `false` (the pod makes no API calls) |
| Admin API + `/metrics` | **off** unless an admin token Secret is supplied |
| `allowPrivateUpstreams` (SSRF guard) | `false` |
| `allowWebhookUrlHeader` | `false` |
| NetworkPolicy | `false` (egress is needed — see below) |
| PodDisruptionBudget | `false` (single replica — see below) |

Because the root filesystem is read-only, the chart mounts emptyDir volumes for
`/tmp` and a journal scratch dir (`/var/run/mockstar`, used by the optional
`--webhook-journal-file`). Tune via `writableVolumes.*`.

### Admin API / metrics token

The admin API (`/_mockstar/...`) and `/metrics` are gated by a token that is
injected **only from an existing Secret** — never a plaintext value. With no
Secret set, both stay disabled.

```bash
kubectl create secret generic mockstar-admin \
  --from-literal=token=$(openssl rand -hex 24) -n mockstar
helm upgrade mockstar ... --set admin.existingSecret=mockstar-admin
```

`/health` and `/ready` are always unauthenticated so kubelet probes work.

### NetworkPolicy (default OFF)

Disabled by default because pass-through routing **and** webhook delivery require
**egress** to your upstreams — a naive deny-all would silently break both. When you
turn it on (`--set networkPolicy.enabled=true`), DNS egress is added automatically,
but **you must add your upstream / webhook destinations** under
`networkPolicy.egress`. Ingress defaults to same-namespace on the mock port.

```yaml
networkPolicy:
  enabled: true
  egress:
    - to:
        - ipBlock: { cidr: 0.0.0.0/0 }
      ports:
        - { protocol: TCP, port: 443 }
```

### PodDisruptionBudget (default OFF)

Off by design. With a single replica, a PDB of `minAvailable: 1` (or
`maxUnavailable: 0`) **blocks voluntary node drains** — `kubectl drain` hangs because
evicting the only pod violates the budget. Enable only if you accept that trade-off.

## Tenant content is OUT-OF-CHART (TN5 resolution)

This chart ships the **mockstar deployment** + a **label-selector pattern**. It does
NOT template your mock files. Apply your tenant content as separate `ConfigMap`
objects carrying the label `mockstar.dev/tenant=<tenant-name>`:

```bash
kubectl create configmap mockstar-tenant-foo \
  --from-file=./mocks/foo/ \
  -n mockstar \
  --dry-run=client -o yaml \
  | kubectl label -f - mockstar.dev/tenant=foo --local -o yaml \
  | kubectl apply -f -
```

The deployment mounts matching ConfigMaps under `/config/mocks/<tenant>/` via a
projected volume. Helm cannot enumerate ConfigMaps by label at render time, so the
chart renders an empty projection keyed off `tenants.labelSelector`; a cluster
controller or kustomize overlay populates the concrete sources. A `helm upgrade` or
`helm rollback` leaves your tenant ConfigMaps untouched — that's the TN5 property we
care about. Bump the rollout (`kubectl rollout restart deploy/mockstar`) after
changing tenant content, since Kubernetes does not rehash projected volumes.

## Named dynamic-mock handlers (optional)

Mocks with `response.kind: "dynamic"` reference named JS/TS handlers. The CLI
resolves these from a `handlers/` directory **relative to the mocks dir** — with
mocks mounted at `/config/mocks`, the default handlers path is `/config/handlers`.

This is **off by default** (most deployments mock statically). To ship handlers,
build a single ConfigMap out-of-chart and point the chart at it; it is mounted
read-only at `/config/handlers` so the default resolution finds it:

```bash
kubectl create configmap mockstar-handlers --from-file=./handlers/ -n mockstar
helm upgrade mockstar ... --set handlers.configMap=mockstar-handlers
```

Unlike Docker, handlers are not hot-reloaded in the cluster — update the
ConfigMap and `kubectl rollout restart deploy/mockstar` to pick up changes.

## Verification

```bash
# verify chart signature (RT-4)
cosign verify \
  --certificate-identity-regexp "^https://github.com/dhanesh/mockstar/" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  oci://ghcr.io/dhanesh/charts/mockstar
```

## Values

See `values.yaml` for the full surface. The most common overrides:

| Key | Purpose |
|---|---|
| `replicaCount` | Keep at `1` — see the single-replica caveat above |
| `strategy.type` | `Recreate` by design (no two stateful pods at once) |
| `image.digest` | Pin to a signed digest (RT-4). Takes precedence over `image.tag` |
| `tenants.labelSelector` | Adjust how the chart discovers tenant ConfigMaps (RT-11) |
| `handlers.configMap` | Optional: mount a ConfigMap of named dynamic handlers at `/config/handlers` (default off) |
| `probes.*` | Tune liveness (`/health`) / readiness (`/ready`) (RT-12) |
| `serviceMonitor.enabled` | Turn on Prometheus scrape (RT-12) |
| `admin.existingSecret` | Inject `MOCKSTAR_ADMIN_TOKEN` from your Secret (enables admin/metrics) |
| `allowPrivateUpstreams` | Allow egress to private/RFC-1918 targets (SSRF guard, default off) |
| `allowWebhookUrlHeader` | Honour `X-Mockstar-Webhook-Url` header (default off) |
| `networkPolicy.enabled` | Enable NetworkPolicy — remember to add egress rules |
| `podDisruptionBudget.enabled` | Enable a PDB — note it blocks drains on a single replica |
| `serviceAccount.create` / `.name` | Manage the pod's ServiceAccount |
| `podSecurityContext` / `containerSecurityContext` | Security hardening (locked down by default) |
| `resources` | Requests + limits (sane defaults, overridable) |
