// Satisfies: RT-11 (helm upgrade preserves labeled tenant ConfigMaps — TN5).
//
// Integration test with helm + kubectl against a kind cluster. Skipped unless
// MOCKSTAR_HELM_TEST=1 is set AND a cluster is reachable via $KUBECONFIG.

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const chartDir = resolve(import.meta.dir, "..", "..", "charts", "mockstar");
const shouldRun = process.env.MOCKSTAR_HELM_TEST === "1";

describe("RT-11: helm upgrade preserves labeled tenant ConfigMaps", () => {
  it("chart directory exists with Chart.yaml", () => {
    expect(existsSync(resolve(chartDir, "Chart.yaml"))).toBe(true);
  });

  it("values.yaml declares tenants.labelSelector", async () => {
    const values = Bun.file(resolve(chartDir, "values.yaml"));
    const text = await values.text();
    expect(text).toMatch(/tenants:/);
    expect(text).toMatch(/labelSelector:/);
    expect(text).toMatch(/mockstar\.dev\/tenant/);
  });

  it("deployment template references the mockstar.dev/tenant label", async () => {
    const tmpl = Bun.file(resolve(chartDir, "templates", "deployment.yaml"));
    const text = await tmpl.text();
    expect(text).toMatch(/mockstar\.dev\/tenant/);
    // @constraint O2 — upgrade path must not touch tenant content
    expect(text).toMatch(/labelSelector/);
  });

  if (!shouldRun) {
    it.skip("(skipped — live helm integration test; set MOCKSTAR_HELM_TEST=1 and KUBECONFIG to run)", () => {});
    return;
  }

  const ns = "mockstar-test";

  it("helm install + apply labeled ConfigMaps + helm upgrade preserves them", async () => {
    await $`kubectl create ns ${ns}`.nothrow().quiet();
    try {
      // Install chart
      // Use a real public image so the pod can be scheduled in CI/local k3s.
      // --wait is omitted: this test verifies ConfigMap persistence, not pod readiness.
      await $`helm install mockstar ${chartDir} -n ${ns} --set image.repository=busybox --set image.tag=latest`.quiet();

      // Apply 3 labeled tenant ConfigMaps
      for (const tenant of ["a", "b", "c"]) {
        await $`kubectl create configmap mockstar-tenant-${tenant} -n ${ns} --from-literal=mocks.json={}`.quiet();
        await $`kubectl label configmap/mockstar-tenant-${tenant} -n ${ns} mockstar.dev/tenant=${tenant}`.quiet();
      }

      // Record UIDs before upgrade
      const before =
        await $`kubectl get cm -n ${ns} -l mockstar.dev/tenant -o jsonpath='{.items[*].metadata.uid}'`.text();

      // Upgrade — no --wait: ConfigMap UIDs are the only assertion
      await $`helm upgrade mockstar ${chartDir} -n ${ns} --set image.repository=busybox --set image.tag=latest`.quiet();

      // UIDs must be unchanged (ConfigMaps were not touched by the chart)
      const after =
        await $`kubectl get cm -n ${ns} -l mockstar.dev/tenant -o jsonpath='{.items[*].metadata.uid}'`.text();
      expect(after).toBe(before);
    } finally {
      await $`helm uninstall mockstar -n ${ns}`.nothrow().quiet();
      await $`kubectl delete ns ${ns}`.nothrow().quiet();
    }
  });
});
