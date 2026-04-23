# mockstar — Helm chart

> Satisfies: RT-10 (Helm OCI push), RT-11 (labeled-ConfigMap tenant pattern), RT-12 (probes + metrics).

Install from OCI:

```bash
helm install mockstar oci://ghcr.io/your-org/charts/mockstar \
  --version 0.1.0 \
  --namespace mockstar --create-namespace
```

## Tenant content is OUT-OF-CHART (TN5 resolution)

This chart ships the **mockstar deployment** + a **label-selector pattern**. It does
NOT template your mock files. Apply your tenant content as separate `ConfigMap` objects
carrying the label `mockstar.dev/tenant=<tenant-name>`:

```bash
kubectl create configmap mockstar-tenant-foo \
  --from-file=./mocks/foo/ \
  -n mockstar \
  --dry-run=client -o yaml \
  | kubectl label -f - mockstar.dev/tenant=foo --local -o yaml \
  | kubectl apply -f -
```

The deployment mounts all matching ConfigMaps under `/config/mocks/<tenant>/`. A
`helm upgrade` or `helm rollback` leaves them untouched — that's the TN5 property
we care about.

## Verification

```bash
# verify chart signature (RT-4)
cosign verify \
  --certificate-identity-regexp "^https://github.com/your-org/mockstar/" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  oci://ghcr.io/your-org/charts/mockstar
```

## Values

See `values.yaml` for the full surface. The most common overrides:

| Key | Purpose |
|---|---|
| `image.digest` | Pin to a signed digest (RT-4). Takes precedence over `image.tag` |
| `tenants.labelSelector` | Adjust how the chart discovers tenant ConfigMaps (RT-11) |
| `probes.*` | Tune liveness/readiness (RT-12) |
| `serviceMonitor.enabled` | Turn on Prometheus scrape (RT-12) |
| `admin.existingSecret` | Inject `MOCKSTAR_ADMIN_TOKEN` from your secret |
