# Deploying mockstar on Kubernetes (Helm)

This guide covers a production-grade, **non-production-environment** deployment of
the mockstar mock + webhook server with the Helm chart in
[`charts/mockstar`](../../charts/mockstar). The chart is secure-by-default
(read-only root FS, non-root, dropped capabilities, admin token via Secret,
private upstreams off, webhook-URL header off).

> **Single replica by design.** mockstar keeps its request/response journal, the
> active-scenario state machine, and the webhook retry queue **in-memory and
> per-pod**. The chart defaults to `replicaCount: 1` and the `Recreate` strategy
> so two stateful pods never run at once. Scaling beyond 1 splits that state —
> see [HA caveat](#single-replica--recreate-rationale--ha-caveat).

> **The TLS-intercepting `mockstar proxy` is NOT deployed by this chart.** It is a
> local-only, experimental dev tool (mkcert dev-CA, macOS/Linux only) and is not
> intended for clusters. The chart ships the mock + webhook server only.

## Prerequisites

- Kubernetes `>= 1.24` (see `Chart.yaml` `kubeVersion`).
- Helm 3.8+ (OCI support) or Helm 4.
- A namespace for the release (examples use `mockstar`).
- Tenant mock content as labeled `ConfigMap`s (see below) — these are applied
  **out-of-chart**; the chart does not template your mocks.
- Optional: the Prometheus Operator (`kube-prometheus-stack`) if you want the
  `ServiceMonitor`.

## Quickstart

```bash
# From the OCI registry (CI publishes the chart by digest):
helm install mockstar oci://ghcr.io/dhanesh/charts/mockstar \
  --version 0.1.0 \
  --namespace mockstar --create-namespace

# ...or from a local checkout:
helm install mockstar ./charts/mockstar \
  --namespace mockstar --create-namespace
```

Verify:

```bash
kubectl -n mockstar rollout status deploy/mockstar
kubectl -n mockstar port-forward svc/mockstar 3000:3000 &
curl -s http://127.0.0.1:3000/health   # {"status":"ok"}
curl -s http://127.0.0.1:3000/ready    # {"ready":true}
```

`/health` and `/ready` are always unauthenticated so the kubelet probes work.

## Supplying per-tenant mock ConfigMaps

Tenant content is **out-of-chart by design**. Each tenant is a `ConfigMap`
carrying the label `mockstar.dev/tenant=<tenant-name>`; the deployment mounts
every matching ConfigMap under `/config/mocks/<tenant>/` via a projected volume.
A `helm upgrade` / `helm rollback` never touches your tenant ConfigMaps.

```bash
# Build a labeled ConfigMap from a local mocks/<tenant>/ directory:
kubectl create configmap mockstar-tenant-foo \
  --from-file=./mocks/foo/ \
  -n mockstar \
  --dry-run=client -o yaml \
  | kubectl label -f - mockstar.dev/tenant=foo --local -o yaml \
  | kubectl apply -f -
```

The label selector is configurable (`tenants.labelSelector`); the default matches
any ConfigMap where `mockstar.dev/tenant` exists. Because Kubernetes does not
rehash projected volumes when the underlying ConfigMaps change, bump the rollout
after editing tenant content:

```bash
kubectl -n mockstar rollout restart deploy/mockstar
```

> Helm cannot enumerate ConfigMaps by label at render time, so the chart renders
> an **empty** projection keyed off the selector. A cluster controller or a
> kustomize overlay populates the concrete `sources`. An empty projection is a
> valid (no-tenant) starting state.

## Supplying named dynamic handlers (optional, default off)

Mocks with `response.kind: "dynamic"` reference named JS/TS handlers. The CLI
resolves them from a `handlers/` directory **relative to the mocks dir** — with
mocks at `/config/mocks`, the default handlers path is `/config/handlers`. Most
deployments mock statically and need nothing here.

To ship handlers, build a single ConfigMap out-of-chart and point the chart at
it; the chart mounts it read-only at `/config/handlers`:

```bash
kubectl create configmap mockstar-handlers --from-file=./handlers/ -n mockstar

helm upgrade mockstar ./charts/mockstar -n mockstar \
  --set handlers.configMap=mockstar-handlers
```

Handlers are **not hot-reloaded** in the cluster (unlike `bun run dev`). Update
the ConfigMap and `kubectl rollout restart deploy/mockstar` to pick up changes.
See [docs/HANDLERS.md](../HANDLERS.md) for authoring rules.

## Single-replica / Recreate rationale + HA caveat

The deployment defaults to `replicaCount: 1` and `strategy.type: Recreate`
because the journal, scenario state machine, and webhook retry queue are all
in-memory and per-pod. `Recreate` tears the old pod down before the new one
starts, so a `helm upgrade` has a brief outage window — acceptable for a
non-prod mock server, and required to avoid two divergent stateful pods.

**Do not scale beyond 1.** With `replicaCount > 1` a scenario switch lands on one
pod, journal reads on another, and webhook retries scatter. If you genuinely need
HA you must front the Service with sticky sessions *and* accept that
scenario/journal/queue state is not consistent across pods.

## Enabling the admin API with a token Secret

The admin API (`/__admin/tenants/...`) and `/metrics` require a token that is
injected as `MOCKSTAR_ADMIN_TOKEN` **only from an existing Secret** — never a
plaintext value in `values.yaml`. With no Secret set, both stay disabled (the
server only enables them when the env var is present). Tokens are compared with
`crypto.timingSafeEqual` (constant-time).

```bash
kubectl create secret generic mockstar-admin \
  --from-literal=token=$(openssl rand -hex 24) -n mockstar

helm upgrade mockstar ./charts/mockstar -n mockstar \
  --set admin.existingSecret=mockstar-admin
```

Auth is two-tier: a **tenant-scoped** token reaches only its own tenant's
endpoints; the **root** token reaches `/metrics`. Pass it as a Bearer token:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3000/__admin/tenants/foo/journal
```

## NetworkPolicy egress note

`networkPolicy.enabled` is **off by default** because pass-through routing *and*
webhook delivery require **egress** to your upstreams — a naive deny-all would
silently break both. When you enable it, DNS egress (UDP/TCP 53) is added
automatically, but you must enumerate every upstream / webhook destination:

```yaml
networkPolicy:
  enabled: true
  allowSameNamespace: true   # ingress from the whole namespace on the mock port
  egress:
    - to:
        - ipBlock: { cidr: 0.0.0.0/0 }
      ports:
        - { protocol: TCP, port: 443 }
```

Note the SSRF posture: egress to private/RFC-1918/link-local targets is blocked
at the application layer unless you opt in with `allowPrivateUpstreams: true`.
Keep the NetworkPolicy and `allowPrivateUpstreams` consistent with each other.

## Probes, metrics, and ServiceMonitor

- **Liveness** → `GET /health` (200 until the process exits; restarts a wedged
  process).
- **Readiness** → `GET /ready` (flips to 503 on fatal error / before drain).
- **Metrics** → `GET /metrics` on the same port (Prometheus text format), gated
  by the root admin token.

Enable a `ServiceMonitor` (requires the Prometheus Operator):

```bash
helm upgrade mockstar ./charts/mockstar -n mockstar \
  --set serviceMonitor.enabled=true
```

Tune scrape via `serviceMonitor.interval` / `serviceMonitor.scrapeTimeout` and
add selector labels with `serviceMonitor.labels`.

## Pinning the image by digest

CI signs and publishes the image **by digest**. Pin it — `image.digest` takes
precedence over `image.tag`:

```bash
helm upgrade mockstar ./charts/mockstar -n mockstar \
  --set image.repository=ghcr.io/dhanesh/mockstar \
  --set image.digest=sha256:<digest>
```

The container runs as non-root uid 10001 with a read-only root filesystem; the
chart backs the required writable paths (`/tmp`, `/var/run/mockstar`) with
emptyDir volumes.

## Minimal values override example

```yaml
# values.prod.yaml
image:
  repository: ghcr.io/dhanesh/mockstar
  digest: sha256:<digest>          # pin by digest

admin:
  existingSecret: mockstar-admin   # enables admin API + /metrics

handlers:
  configMap: mockstar-handlers     # only if you use named dynamic handlers

serviceMonitor:
  enabled: true

networkPolicy:
  enabled: true
  egress:
    - to: [{ ipBlock: { cidr: 0.0.0.0/0 } }]
      ports: [{ protocol: TCP, port: 443 }]

# Keep these at their secure defaults:
# replicaCount: 1
# strategy.type: Recreate
# allowPrivateUpstreams: false
# allowWebhookUrlHeader: false
```

```bash
helm upgrade --install mockstar ./charts/mockstar \
  -n mockstar --create-namespace -f values.prod.yaml
```

## Uninstall

```bash
helm uninstall mockstar -n mockstar
```

Helm removes the chart-managed objects (Deployment, Service, ServiceAccount,
and any enabled NetworkPolicy / PDB / ServiceMonitor). It does **not** remove
out-of-chart objects you created yourself — delete those explicitly:

```bash
kubectl -n mockstar delete configmap -l mockstar.dev/tenant   # tenant content
kubectl -n mockstar delete configmap mockstar-handlers        # if created
kubectl -n mockstar delete secret mockstar-admin              # admin token
# kubectl delete namespace mockstar                           # if dedicated
```

## See also

- [charts/mockstar/README.md](../../charts/mockstar/README.md) — full values surface.
- [SECURITY.md](../../SECURITY.md) — security policy and posture.
- [docs/SECURITY.md](../SECURITY.md) — threat model.
- [docs/base-in-reality/2026-06-21-audit.md](../base-in-reality/2026-06-21-audit.md) — security audit.
