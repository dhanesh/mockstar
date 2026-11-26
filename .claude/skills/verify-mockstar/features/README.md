# verify-mockstar feature map

Sweep order. Each line: the feature id and what a user sees.

- [static-mocks](static-mocks.md) — a matched route returns its templated status and body; an unmatched one returns a diagnostic 404
- [tenant-selection](tenant-selection.md) — the path prefix, header or subdomain picks the tenant; tenants cannot see each other's mocks
- [scenarios](scenarios.md) — a request matching a scenario's `when` gets the scenario response, and the journal names it
- [webhooks](webhooks.md) — a mock fires its webhooks after responding, each with its own delivery id
- [cli-migrate-schema](cli-migrate-schema.md) — `migrate --schema` bumps the pinned `$schema` minor and changes nothing else
