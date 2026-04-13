# Deployment

> Satisfies RT-11.2 (persona deployment guides) and documents the production requirement for a restart-capable orchestrator (RT-3.3).

Mockstar ships four distribution channels. Pick the one that matches your persona.

## SDET — library embed

Best fit for test suites that want a mock server in-process, no extra daemon.

```ts
import { test, expect } from 'bun:test';
import { launch } from 'mockstar';

test('user service calls mock correctly', async () => {
  const instance = await launch({
    configRoot: './fixtures/mocks',
    handlersDir: './fixtures/handlers',
    deterministic: true,    // RT-12
    watch: false,            // no file-watch in CI
    installCrashHandlers: false, // let the test runner own the process
  });
  try {
    // Call your code-under-test, which hits the mock server...
    const res = await instance.server.hono.request('http://localhost/users/1', {
      headers: { 'x-mockstar-tenant': 'default' },
    });
    expect(res.status).toBe(200);
  } finally {
    await instance.stop();
  }
});
```

**Boot SLO:** `< 200 ms` (TN4).

## Developer — bunx / npm

Best fit for iterating on mocks locally with hot-reload.

```bash
bunx mockstar ./mocks --handlers ./handlers
# open http://localhost:3000
```

Edit any file under `mocks/{tenant}/*.json` — Mockstar reloads only that tenant (T8).

**Boot SLO:** `< 200 ms` (TN4).

## DevOps — Docker on shared staging

Best fit for a long-running multi-tenant instance inside a cluster. Tenants self-serve config via ConfigMap mount or volume update.

Example K8s deployment (abbreviated):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mockstar
spec:
  template:
    spec:
      restartPolicy: Always              # required — see TN2 / RT-3.3
      containers:
        - name: mockstar
          image: ghcr.io/mockstar/mockstar:v1
          args: ["serve", "/config/mocks", "--host", "0.0.0.0"]
          env:
            - name: MOCKSTAR_ADMIN_TOKEN
              valueFrom: { secretKeyRef: { name: mockstar-root, key: token } }
          volumeMounts:
            - name: mock-config
              mountPath: /config
          readinessProbe:
            httpGet: { path: /ready, port: 3000 }
          livenessProbe:
            httpGet: { path: /health, port: 3000 }
      volumes:
        - name: mock-config
          configMap: { name: mockstar-mocks }
```

Per-tenant admin tokens are stored in each tenant's `tenant.json` file inside the ConfigMap (RT-7.1).

**Boot SLO:** `< 200 ms` for Mockstar's own startup (container start overhead is additional — TN4).

> ⚠️ **v1 limitation (TN1).** Runtime mutation of mocks requires filesystem access or a ConfigMap update. A runtime write-API is planned for v1.1. Teams that need live mutation today should treat mock configs as code and ship via a GitOps pipeline.

## Offline CI / Windows — compiled binary

Best fit for environments without Bun installed.

```bash
bun build src/cli.ts --compile --outfile dist/mockstar
./dist/mockstar ./mocks
```

**Boot SLO:** `< 500 ms` — compiled binary carries runtime init overhead (TN4).

## Orchestrator restart policy (MANDATORY in production)

Mockstar uses a crash-only design (TN2 / RT-3). Uncatchable process-level errors trigger a graceful exit expecting restart. Configure:

| Runtime | Setting |
|---|---|
| Docker | `--restart=always` or `restart: always` in compose |
| K8s | `spec.restartPolicy: Always` (default for Deployments) |
| systemd | `Restart=on-failure` (or `always`) |
| bare metal / dev | Not supported — `bunx` prints the crash and exits |

When `/ready` returns `503`, your load balancer should drain the instance. `/health` remains `200` until the process is gone — use it for liveness-only.
