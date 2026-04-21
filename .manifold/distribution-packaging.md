# distribution-packaging

## Outcome

Mockstar is installable, runnable, and deployable across all three target personas — **Developers**, **SDETs**, and **DevOps** — via one-command flows that match each persona's native toolchain:

- **Developer**: `bunx mockstar init` scaffolds a starter tree; `bunx mockstar ./mocks` runs locally with file-watch hot reload; the mock JSON files get IDE autocomplete from a published JSON Schema.
- **SDET**: `npm i -D mockstar` (or `bun add -D`) installs a typed library; `launch()` API ships with `.d.ts` declarations and documented setup patterns for Jest, Vitest, and `bun:test`; journal-assertion helpers make mock-call verification ergonomic.
- **DevOps**: `docker pull ghcr.io/<org>/mockstar:<version>` returns a signed, SBOM-attested, multi-arch image; `helm install mockstar <chart>` (or an equivalent Kustomize base) deploys with per-tenant `ConfigMap` mounts, documented liveness/readiness probes, Prometheus `/metrics`, and a working upgrade/rollback path.

Cross-cutting requirements:
- A published versioning policy (semver) with stable `v0.x` commitment, changelog automation, and deprecation path.
- CI pipeline that publishes to npm + GHCR on tag, with trivy/grype scan + cosign signature + CycloneDX SBOM attached.
- `CONTRIBUTING.md` and a team-sharing workflow (forking / per-team mock repos / PR templates) so a team can adopt mockstar without upstream changes.

Success is measured by a first-time user of each persona getting a working mockstar in **under 5 minutes** from a single copy-pasteable command, with no manual build step.

---

## Locked Decisions (Iteration 1)

- **Module format:** ESM-only. No dual CJS/ESM package. Node 22.14+ required.
- **K8s artifact:** Helm chart distributed as an OCI artifact in GHCR (not a classic `gh-pages` chart repo, not Kustomize).
- **Versioning:** v0.x — public API may break on a minor bump; patch is safe. This is an honest pre-1.0 contract, documented in the README and CHANGELOG.
- **Publishing targets (first cut):** npm package + GHCR container image + Helm chart (OCI) + standalone binary (4 platforms).

---

## Constraints

### Business

#### B1: npm and image signing use Trusted Publishing / OIDC only — no long-lived tokens

Every publish step (npm, GHCR container, Helm chart OCI push, cosign signing) must authenticate via GitHub OIDC. `NPM_TOKEN`, GHCR PATs, and cosign keypairs stored as secrets are banned.

> **Rationale:** Long-lived publishing secrets are the single biggest supply-chain attack vector in the OSS world (ua-parser-js, event-stream, colors.js all started there). npm Trusted Publishing went GA in 2026 and eliminates this class of token entirely. Derived from pre-mortem story 1 ("secret leaked in CI logs"). `challenger: technical-reality` — the infrastructure exists, we just have to use it.

#### B2: First-time-user install-to-running is under 5 minutes, per persona

From a single copy-pasteable command in the README, each persona (Dev/SDET/DevOps) reaches a running mock in ≤5 minutes on a fresh laptop with only the persona's expected baseline installed (Node 22.14+ or Docker, respectively).

> **Rationale:** This is the acceptance criterion from the outcome statement. "Works on my machine" is measured as wall-clock time on a clean environment, not as a happy-path demo.

#### B3: v0.x SemVer policy is published and enforced

The README and `docs/VERSIONING.md` state: on v0.x, a minor bump MAY break the public API (`launch()`, mock-file schema, CLI flags); patch bumps are safe. The `1.0.0` release will upgrade this to strict SemVer.

> **Rationale:** Honesty beats accidental breakage. v0.x users need to know patch pins are safe and minor pins may require migration. This is the pre-1.0 contract used by most high-quality OSS (Zod, tRPC, Drizzle all followed this pattern).

#### B4: Every release tag has a CHANGELOG.md entry

No release workflow runs without a matching CHANGELOG entry for the tagged version. The entry distinguishes `Breaking`, `Added`, `Changed`, `Fixed`.

> **Rationale:** A tag without a changelog is a silent breaking change. The CI release workflow should fail if the version being tagged is absent from CHANGELOG.md.

### Technical

#### T1: The npm package is ESM-only with `.d.ts` types

`package.json` has `"type": "module"`. The `exports` map has `"types"` first in each condition (required by TypeScript's moduleResolution: bundler / node16 — types-first or types-last is load-bearing). No `main` field fallback, no CJS build.

> **Rationale:** Locked decision. 2026-era Node (22.14+, 23+) can `require()` ESM, making dual-package hazard obsolete. ESM-only ships smaller, simpler, and avoids the CJS/ESM interop footguns. `types-first` in exports is a subtle but frequent 2026-era bug — tsc picks the condition with `.js` first and never resolves types.

#### T2: Container image is multi-arch (linux/amd64 + linux/arm64)

Built with `docker buildx` as a manifest list. Both arches must pass the same integration smoke test before the manifest is published. No single-arch images.

> **Rationale:** Apple Silicon dev laptops and AWS Graviton prod nodes make arm64 a first-class target, not a nice-to-have. A single-arch image forces emulation at pull time, which breaks the 5-minute promise (B2) on half of real machines.

#### T3: Standalone binary is built for 4 targets

`bun build --compile` produces binaries for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`. Each is smoke-tested in CI (run `--version` and a minimal `mockstar ./fixtures/minimal`) before release.

> **Rationale:** Locked decision. Standalone binaries unblock air-gapped environments and let ops teams pin to a specific release SHA without needing Node or Docker. Smoke test, not just build — cross-compilation can produce a binary that fails to load.

#### T4: Helm chart is published as an OCI artifact in GHCR

`helm push oci://ghcr.io/<org>/charts/mockstar` on release. No classic `helm repo add` workflow. Consumers install via `helm install mockstar oci://ghcr.io/<org>/charts/mockstar --version <v>`.

> **Rationale:** Locked decision. OCI charts share the same registry (GHCR), same signing mechanism (cosign), same access controls as the container image. ArgoCD and Flux both have first-class OCI chart support. A gh-pages chart repo would require a separate signing workflow and a parallel auth story.

#### T5: Every release is reproducible from a tagged commit

Given the git tag, running the release workflow produces byte-identical artifacts modulo timestamps. `SOURCE_DATE_EPOCH` is set; Bun bundle is deterministic; Docker builds use pinned base image digests (not tags).

> **Rationale:** Reproducibility is what makes SLSA L3 provenance (S3) meaningful — an attested provenance that can't be reproduced provides no forensic value. Pinned digests (not tags) for the base image also prevent silent upstream changes.

#### T6: A JSON Schema for mock config is published at a stable URL

The schema for `mocks/*.json` files is published at a versioned, cacheable URL (`https://mockstar.dev/schemas/v<major>/mock.json`). Generated files include `"$schema"` references so IDEs (VS Code, IntelliJ) resolve autocomplete.

> **Rationale:** Schema discoverability is the only reason mock files feel ergonomic to edit. Versioning is in the URL path (not query string) so CDNs cache correctly. Without this, every dev has to learn the schema from docs, which kills the 5-minute promise.

#### T7: Standalone binary stays under 100 MB compressed, per target

Each `bun build --compile` output, after tar.gz compression, must be ≤100 MB. CI fails the release if any target exceeds the ceiling.

> **Rationale:** `source: pre-mortem` — Bun's `--compile` includes the full runtime (~120–150 MB uncompressed for a trivial program). Without a ceiling, the binary bloats on every dependency addition until it bounces off corporate proxies with download limits. 100 MB compressed is roughly Bun's own release binary size — achievable with discipline, impossible to hit by accident.

### User Experience

#### U1: `bunx mockstar init` scaffolds a working starter tree

Running `bunx mockstar init` in an empty directory produces a tree that, when immediately run with `bunx mockstar ./mocks`, serves a demo endpoint. The scaffold includes: one tenant dir with `tenant.json`, one mock file demonstrating Tier 1 + Tier 2 tokens, a README pointing at `docs/`.

> **Rationale:** `init` has to be the answer to "I don't know what mockstar wants from me." If the output of `init` doesn't run on the first `mockstar` invocation, every new user hits friction in the first 60 seconds.

#### U2: `launch()` API has documented setup patterns for Jest, Vitest, and bun:test

`docs/SDET.md` (new) contains copy-paste recipes for each of the three frameworks, covering: fixture setup/teardown, port allocation, journal-assertion helpers, baseURL injection. Each recipe is a runnable integration test in `examples/sdet-<framework>/`.

> **Rationale:** SDETs don't adopt libraries on the strength of API reference docs — they adopt what has a 10-line working example in their framework of choice. Three frameworks covers >95% of the JS testing market in 2026.

#### U3: CONTRIBUTING.md and team-sharing workflow are documented

Two new docs: `CONTRIBUTING.md` (upstream contribution: dev setup, test invariants, PR template) and `docs/TEAM-WORKFLOW.md` (fork / private mirror / per-team mock repo pattern / how to layer team-specific mocks over upstream without touching upstream code).

> **Rationale:** Teams adopt mockstar differently from individual users — they need a story for "how do we share mocks across the team without every engineer maintaining their own fork of every edge case." This pattern exists; it just needs to be written down.

#### U4: Install and runtime error messages reference `docs/` paths

Every `Error`/`console.error` from install scripts, the CLI, or `launch()` includes a short pointer to the relevant doc (`See docs/CONFIG.md#<anchor>`). No error is purely diagnostic.

> **Rationale:** A user who hits an error and can't tell which doc to read next is a user who opens a GitHub issue. Issues that could have been resolved by a link are the lowest-leverage support cost.

### Security

#### S1: Container image is signed with cosign keyless via GitHub OIDC, bound to the manifest digest

On publish, `cosign sign --yes ghcr.io/<org>/mockstar@sha256:<digest>` runs with GitHub OIDC as the identity provider. The signature is pushed to the transparency log (Rekor). Verification uses the repo's identity (`github-workflow-repository`), not a keypair. Signing must target the digest, never a tag.

> **Rationale:** Signing by tag is a no-op for security — the tag can be re-pointed to a different digest after signing and the signature remains valid. Keyless OIDC means no private key to rotate, lose, or leak. `challenger: regulation` — this is the SLSA / Executive Order 14028 baseline, not a stylistic choice.

#### S2: A CycloneDX SBOM is attached via `cosign attest`

On publish, a CycloneDX JSON SBOM is generated (via `syft` or `cdxgen`) and attached as an OCI attestation with `cosign attest --type cyclonedx --predicate sbom.json`. The SBOM includes every npm dependency with version and license.

> **Rationale:** SBOM is the minimum downstream-traceability artifact. If a CVE lands on one of our transitive deps, downstream operators need to be able to run `cosign download attestation` and answer "am I exposed?" in under 10 seconds.

#### S3: SLSA Level 3 build provenance is attached

The release workflow runs via the `slsa-github-generator` reusable workflow, producing an in-toto attestation with SLSA L3 provenance. The provenance is attached as a cosign attestation alongside the SBOM.

> **Rationale:** SLSA L3 requires a hermetic, isolated, non-falsifiable build (which the reusable workflow provides by running on GitHub-hosted runners with a verifier). It's the current bar for "this binary was built from exactly this source by exactly this workflow." `challenger: regulation`.

#### S4: Release is blocked on any Critical-severity CVE

`trivy image` and `grype` both scan the final image before it's signed. Any `CRITICAL` CVE with a known fix blocks the release. `HIGH` CVEs are warnings; nothing below `HIGH` gates the release.

> **Rationale:** The boundary exists to force a decision: either fix the CVE or explicitly acknowledge the risk before shipping. "Known critical with a fix available" being shipped is indefensible; "known high without a fix yet" is a product decision.

#### S5: npm publish uses Sigstore provenance attestation (auto via Trusted Publishing)

When `npm publish --provenance` runs under GitHub OIDC, npm automatically generates and attaches a Sigstore provenance attestation (this is built into `npm` 11.5.1+ and enabled by Trusted Publishing). The npm package page displays the verified provenance badge.

> **Rationale:** This is the npm-side equivalent of S1/S3 for container artifacts. Without `--provenance`, the package ships with no cryptographic link back to the source commit, and dependency-audit tooling can't verify provenance. `challenger: regulation`.

### Operational

#### O1: Helm chart supports per-tenant ConfigMap mount, probes, and `/metrics`

The default chart values ship with: a `tenants` key that maps tenant names to ConfigMap data, a liveness probe on `/health`, a readiness probe on `/ready`, and a `ServiceMonitor` / `PodMonitor` option that points Prometheus at `/metrics`. Upgrading the chart does not lose per-tenant state — ConfigMap updates are surgical, not destructive.

> **Rationale:** These four things are the "operable in prod" baseline for a k8s service in 2026. A chart that needs user-written extensions to be monitored is a chart that won't be monitored.

#### O2: Helm chart has a documented upgrade and rollback path

`docs/DEPLOYMENT.md` includes worked examples for `helm upgrade` (including the case where `values.yaml` schema has changed between versions) and `helm rollback` (including what state is lost and what is preserved).

> **Rationale:** The rollback path needs to be tested, not assumed. Many charts that work on `helm install` break on `helm upgrade` because a required field changed shape.

#### O3: Release pipeline completes end-to-end in under 15 minutes

From `git tag v<x>` push to `npm publish + ghcr push + helm push + github release` all completing, p99 ≤ 15 minutes. Includes multi-arch builds, all scans, all signing, all smoke tests.

> **Rationale:** A 15-minute release is the difference between "we can hot-fix a CVE same day" and "we can hot-fix next sprint." Statistical threshold because some runs (cold runner, Sigstore slow) will fringe over; the p99 is what matters operationally.

#### O4: Deprecations give at least one minor-version notice

Any planned removal (API, CLI flag, config field) is deprecated with a runtime warning in version `0.N.0`, and can only be removed starting `0.N+1.0`. Deprecation warnings link to a migration note.

> **Rationale:** Per B3, a minor bump may break — but giving users at least one version to see the warning before the break is the minimum humane contract. "Surprise removal with no warning" is the worst possible pre-1.0 experience.

#### O5: Release pipeline tolerates transient npm / GHCR / Sigstore outages

Each network-dependent step (npm publish, ghcr push, cosign sign) retries on transient failure (exponential backoff, max 3 attempts). A failure after retries halts the release cleanly and leaves no partial state (e.g., an image signed but not pushed, or published but not signed).

> **Rationale:** `source: pre-mortem` — Sigstore has had visible outages in 2024–2025. A release pipeline that fails hard on a 30-second Fulcio hiccup loses the release window and may leave an unsigned artifact in GHCR if ordering is wrong. The halt-cleanly requirement is the load-bearing half of this — a partial release is worse than no release.

---

## Tensions

### TN1: SLSA L3 attestation vs release latency ceiling

**Between:** S3 (SLSA L3 build provenance) ↔ O3 (release pipeline p99 ≤ 15 min)

The `slsa-github-generator` reusable workflow runs in a separate isolated job to produce the in-toto provenance attestation. On a cold GitHub-hosted runner this adds 4–6 minutes. Combined with multi-arch buildx (~5 min) + scans (~2 min) + sign+push (~2 min) + smoke tests (~2 min), the p99 sits right at the 15-minute ceiling with no headroom.

**TRIZ:** Technical contradiction — Verifiability vs. Speed. Principles: **P1 (Segmentation)**, P10 (Prior action), P15 (Dynamization).

> **Resolution:** (Option B — Segment by release type.) SLSA L3 is required on every **stable** release (`x.y.z` with no pre-release suffix); **skipped** on `alpha`/`beta`/`rc` pre-releases. The strict signature/SBOM invariants (S1, S2, S5) still apply to every release — only the SLSA L3 *build* provenance is segmented. This gives us the supply-chain gold standard where it matters most (production-consumable releases) while preserving a fast hotfix path.

> **Rationale:** S1/S2/S5 are INVARIANTs (non-negotiable); S3 is a GOAL. When a GOAL tension-collides with a BOUNDARY, segment by context rather than weakening either. Pre-releases are explicitly opt-in (`--include-prereleases` on tooling), so consumers who pin to `^0.x.0` never pull an un-attested artifact.

**Propagation:** S3 LOOSENED (scope narrows to stable releases); O3 UNCHANGED; B3 TIGHTENED (versioning policy must formally distinguish pre-release from stable).

**Validation:** (1) CI logs show SLSA L3 attestation for every stable tag; (2) pre-release tags produce no SLSA step; (3) p99 of release wall-clock ≤ 15 min over trailing 20 releases.

---

### TN2: Standalone binary size ceiling vs cross-platform coverage

**Between:** T7 (binary ≤100 MB compressed per target) ↔ T3 (4-target coverage: darwin-arm64, darwin-x64, linux-arm64, linux-x64)

`bun build --compile` bundles the full Bun runtime. Linux-x64 in particular includes glibc adapters that push the compressed binary above 100 MB before any user code is counted. Holding T7 strict forces dropping a target; dropping linux-x64 breaks CI runners and corporate Linux desktops.

**TRIZ:** Technical contradiction — Portability vs. Size. Principles: **P1 (Segmentation)**, P27 (Cheap short-living), P35 (Parameter changes).

> **Resolution:** (Option B — Relax T7 to 150 MB.) The T7 threshold moves from 100 MB → 150 MB compressed per target. linux-x64 stays. 150 MB is still a reasonable download (< 10 seconds on a 100 Mbps connection), and relaxing a GOAL ceiling is strictly better than violating T3 coverage.

> **Rationale:** Segmentation in principle (option C: a "lite" variant alongside full) is appealing but adds product surface area we don't need in v0.x. Relaxing the size ceiling is the smallest blast-radius change.

**Propagation:** T7 LOOSENED (ceiling 100 → 150 MB); T3 UNCHANGED; B2 TIGHTENED marginally (larger download on constrained networks, but still under 5 min budget at ≥ 25 Mbps).

**Validation:** (1) CI asserts each of 4 binaries compresses ≤ 150 MB; (2) download-and-run smoke test from the GitHub Release completes in < 60 s on a 100 Mbps connection.

---

### TN3: 5-minute install promise vs mandatory signature verification

**Between:** B2 (5-min install) ↔ S1 + S2 + S5 (signatures, SBOM, provenance must exist and be verifiable)

If the first-run flow requires users to install cosign, fetch the signature, verify it, and only then run mockstar, the "single copy-pasteable command" becomes a three-step ritual. B2 breaks.

**TRIZ:** Physical contradiction — must verify (security) AND must be one command (UX). Principles: **P1 (Segmentation)**, P10 (Prior action), **P24 (Intermediary)**.

> **Resolution:** (Option C — Package-manager-native verification by persona.) Rely on built-in verification where the ecosystem provides it automatically: npm CLI 11.5.1+ verifies Sigstore provenance on every install with zero user action; Helm's `--verify` flag is a single extra token. For container images, document an explicit `cosign verify` one-liner in the DevOps quickstart **as the deploy-to-prod step**, not as a first-run gate. The guarantee is that signatures *exist and are verifiable*; enforcement is per-persona and per-environment.

> **Rationale:** The invariants S1/S2/S5 speak to the artifact's provenance, not to every consumer's verification ritual. This is the difference between "signed code exists" (invariant) and "every run re-verifies" (policy). The former is what the supply chain requires; the latter is a deployment policy that operators can opt into.

**Propagation:** B2 UNCHANGED; S1 / S2 LOOSENED (enforceability narrows from runtime-mandatory to publish-mandatory); S5 UNCHANGED (npm-side verification is automatic); U4 TIGHTENED (DevOps quickstart must show the explicit cosign verify step with a doc link).

**Validation:** (1) README quickstart per persona runs end-to-end in <5 min on a clean machine (automated in `quickstart-smoke` workflow); (2) `docs/DEPLOYMENT.md` includes a cosign one-liner that passes against a released tag; (3) npm publish provenance badge visible on the package page.

---

### TN4: ESM-only library vs SDET environments on older Jest

**Between:** T1 (ESM-only library) ↔ B2 (5-min install, SDET persona slice)

Jest 29 + ts-jest in CJS mode cannot import an ESM-only package without `--experimental-vm-modules` and a `transformIgnorePatterns` exception. A team stuck on this stack hits `SyntaxError: Cannot use import statement outside a module` and the 5-min promise breaks for them.

**TRIZ:** Technical contradiction — Modernness vs. Compatibility. Principles: **P3 (Local quality)**, P15 (Dynamization), **P24 (Intermediary)**.

> **Resolution:** (Option C — Supported frameworks + documented escape hatch.) Declare Jest 30+, Vitest 1+, and `bun:test` as zero-config supported frameworks. Provide a `examples/sdet-jest29/` directory with a runnable integration test proving that Jest 29 works with a 3-line `jest.config.js` addition (`transformIgnorePatterns: ['node_modules/(?!mockstar)']` + `--experimental-vm-modules`). The 5-min promise applies per supported framework; Jest 29 is "supported with a clearly documented 3-line addition" — still under 5 min for any team that has already configured their Jest once.

> **Rationale:** T1 is an INVARIANT tied to a locked decision. Shipping a CJS build (option B) is out. Declaring Jest 29 unsupported (option A) is too user-hostile for a library that aspires to meet SDETs where they are. Option C preserves the invariant and makes the escape hatch a well-lit path.

**Propagation:** T1 UNCHANGED; B2 UNCHANGED for supported frameworks; U2 TIGHTENED (must ship `examples/sdet-jest29` alongside the zero-config examples, and CI-test it).

**Validation:** (1) `examples/sdet-jest29` is a runnable integration test exercising `launch()`; (2) `examples/sdet-jest30`, `-vitest`, `-bun-test` all run zero-config; (3) `docs/SDET.md` lists version floors per framework with a link to each example.

---

### TN5: Helm upgrade vs per-tenant ConfigMap preservation

**Between:** O1 (chart ships per-tenant ConfigMap mounts, probes, /metrics) ↔ O2 (documented upgrade/rollback path, non-destructive to tenant state)

Standard Helm behavior regenerates all templated resources on `helm upgrade`. If per-tenant ConfigMaps are templated by the chart's `values.yaml`, upgrading without a tenant's block regenerates without it — silently wiping any hot-patched mock overrides that tenant applied.

**TRIZ:** Technical contradiction — Chart cohesion vs. Tenant state durability. Principles: **P1 (Segmentation)**, P11 (Beforehand cushioning), P13 (The other way round).

> **Resolution:** (Option A — Segment tenant content outside the chart.) The chart owns the deployment, the service, and a single "tenants index" ConfigMap (which tenants exist, their routing prefixes). **Per-tenant mock content lives in separate ConfigMaps labeled `mockstar.dev/tenant=<name>`**, managed by the user (kubectl apply, kustomize overlay, or a side-chart). The pod mounts ConfigMaps by label selector, not by templated name. `helm upgrade` touches deployment + index only, never tenant content.

> **Rationale:** This is the standard k8s operator-style separation: the chart is the platform, the labeled resources are the data. It's also the pattern that makes team-sharing (U3) natural — teams can maintain their own tenant-content repos without forking the chart.

**Propagation:** O1 TIGHTENED (chart must document the labeled-ConfigMap pattern explicitly, not offer both options); O2 LOOSENED (upgrade path is simpler because the chart doesn't touch content); U3 TIGHTENED (team-sharing docs must describe how teams distribute labeled tenant ConfigMaps).

**Validation:** (1) Integration test: `helm install` + kubectl-apply 3 labeled tenant ConfigMaps + `helm upgrade` to next minor — all 3 ConfigMaps persist with original content; (2) `helm rollback` preserves labeled ConfigMaps unchanged; (3) chart's `values.yaml` documents the `mockstar.dev/tenant=<name>` label selector contract.

---

### TN6: Reproducible build vs Bun compile toolchain drift *(blocking)*

**Between:** T5 (release reproducible from tagged commit) ↔ T3 (4-target standalone binary)

`bun build --compile` bundles the Bun runtime + user code into a single executable. Different Bun versions produce different binaries even from identical source. Without explicit version pinning, the "reproducible from a tagged commit" claim is false — a re-run six months later with a new default Bun will produce a different artifact.

**TRIZ:** Technical contradiction — Determinism vs. Tool autonomy. Principles: **P10 (Prior action)**, **P35 (Parameter changes)**, P40 (Composite).

> **Resolution:** (Option A+B — Pin Bun version and record it in provenance.) A `.bun-version` file at repo root is the single source of truth for local dev and CI. The release pipeline runs Bun via a pinned container image (`oven/bun:<digest>`, not a floating tag). The SLSA provenance (S3) records the Bun container digest so a downstream verifier can reproduce the exact toolchain. Upgrading Bun becomes a deliberate, release-notes-worthy commit.

> **Rationale:** This is listed as a *blocker* in `blocking_dependencies` — until the pinning mechanism is in place, neither T5 nor T3 can hold. m3 should seed a required truth off this.

**Propagation:** T5 TIGHTENED (stricter tool-pinning); T3 TIGHTENED (Bun upgrades become deliberate events); S3 LOOSENED (provenance is now reproducible, strengthening the attestation).

**Validation:** (1) `.bun-version` file exists and is the source of truth; (2) CI fails if invoked Bun version ≠ `.bun-version`; (3) two independent CI runs from the same tag produce bit-identical binaries for all 4 targets (verified via `diffoscope`).

---

### TN7: JSON Schema URL stability vs v0.x breaking changes *(blocking)*

**Between:** T6 (stable JSON Schema URL for IDE autocomplete) ↔ B3 (v0.x may break the public API — including the mock-file schema — on minor bumps)

If the URL is `…/v0/mock.json` and v0.2 breaks the schema, every existing mock file with `"$schema": "…/v0/mock.json"` gets misleading autocomplete on upgrade — or worse, IDE validation rejects valid files. If the URL is per-minor, users lose "latest docs" stability.

**TRIZ:** Technical contradiction — URL stability vs. Schema evolution. Principles: **P1 (Segmentation)**, P15 (Dynamization), **P17 (Another dimension)**.

> **Resolution:** (Option C — Dual-URL with per-minor pin as default.) Publish both `…/v0/mock.json` (always the latest) and `…/v0.N/mock.json` (frozen per-minor snapshot). `mockstar init` writes the **per-minor URL by default** so users get deterministic autocomplete that doesn't drift under them. Power users can manually pin to `…/v0` if they want auto-updates. A `mockstar migrate --schema` CLI command rewrites existing mock files from one per-minor URL to another.

> **Rationale:** This is listed as a *blocker* because the URL scheme has to be decided and published before any released mock files can reference a stable URL. m3 should seed a required truth off this.

**Propagation:** T6 TIGHTENED (must publish two URL forms + update `mockstar init`); B3 UNCHANGED; O4 TIGHTENED (deprecation policy extends to URLs — a deprecated per-minor URL must remain served for at least one more minor).

**Validation:** (1) both URL forms return HTTP 200 with valid JSON Schema; (2) CDN cache headers (ETag, Cache-Control) set correctly; (3) `mockstar init` writes per-minor URL by default; (4) `mockstar migrate --schema` rewrites existing files to a target minor.

---

### Summary

| Tension | Type | Between | Resolution (letter) | Status |
|---|---|---|---|---|
| TN1 | trade_off | S3 ↔ O3 | B — Segment by release type | resolved |
| TN2 | trade_off | T7 ↔ T3 | B — Relax size ceiling to 150 MB | resolved |
| TN3 | trade_off | B2 ↔ S1/S2/S5 | C — Package-manager-native verification per persona | resolved |
| TN4 | trade_off | T1 ↔ B2 | C — Supported frameworks + documented Jest 29 escape hatch | resolved |
| TN5 | resource_tension | O1 ↔ O2 | A — Segment tenant content outside the chart | resolved |
| TN6 | hidden_dependency *(blocking)* | T5 ↔ T3 | A+B — Pin Bun version + record in provenance | resolved |
| TN7 | hidden_dependency *(blocking)* | T6 ↔ B3 | C — Dual-URL scheme with per-minor default | resolved |

**Dominant TRIZ pattern:** **P1 (Segmentation) used in 5 of 7 resolutions.** The feature has natural seams along release-type (TN1), persona (TN3), tenant content (TN5), and schema version (TN7) — the design should honor these boundaries rather than try to collapse them.

**Blocking dependencies exported to m3:** TN6 (Bun pinning) and TN7 (dual-URL scheme) must be resolved before their dependent constraints can hold.

---

## Required Truths

### RT-3: OIDC wiring (id-token: write + npm Trusted Publishing + Sigstore Fulcio trust)

The release workflow declares `permissions: id-token: write`, the repo is registered for npm Trusted Publishing against the `release.yml` workflow, and the repo's OIDC issuer (`https://token.actions.githubusercontent.com`) is trusted by Sigstore Fulcio for the specific subject claim `repo:<org>/mockstar:ref:refs/tags/v*`. Without this, every signing path collapses: `npm publish --provenance` cannot mint a provenance statement, `cosign sign` keyless cannot obtain a Fulcio certificate, and `slsa-github-generator` cannot attest.

Seeds: DRT-1 (high confidence). Maps to B1, S1, S2, S3, S5.

> **Gap:** No `.github/workflows/release.yml` exists. npm Trusted Publishing is not registered. No `docs/OIDC-SETUP.md` documents the one-time console steps. OIDC audience/subject mismatches fail silently — this must be verified end-to-end before any other signing RT can close.

---

### RT-4: Cosign keyless signing by digest + CycloneDX SBOM attestation

The release workflow signs every published container image and Helm chart OCI artifact with `cosign sign --yes ghcr.io/.../<name>@sha256:<digest>` (never by tag — tag attacks must not propagate) and attaches a CycloneDX SBOM via `cosign attest --type cyclonedx --predicate sbom.cdx.json ...`. `cosign verify` with the repo's OIDC identity claim succeeds against the published digest in CI.

Seeds: DRT-2 (high confidence). Maps to S1, S2.

> **Gap:** No cosign invocation exists anywhere. No SBOM generation step (e.g. `cyclonedx-bom` or `syft`). No `tests/ci/verify-signature.test.ts` exercising the digest-binding path. Depends on RT-3.

---

### RT-5: Release-type detection (stable vs pre-release)

The release workflow detects, from the tag alone, whether a release is stable (`vX.Y.Z`) or pre-release (`vX.Y.Z-rc.N`, `-beta.N`, `-alpha.N`) and gates the SLSA L3 build-provenance step on `is_stable == true`. Alphas and betas still get cosign + SBOM, but do not invoke the SLSA reusable workflow — this is the TN1 resolution.

Seeds: n/a (decision-locked in TN1). Maps to S3, B3.

> **Gap:** Workflow does not exist yet. Once written, the `is_prerelease` detection is a small regex step — the work is documentation + wiring, not research. Status is SPECIFICATION_READY: decision is complete; only implementation remains.

---

### RT-3's dependents — the signing surface

The following four RTs all depend on RT-3 being wired correctly. They form the "signing surface" chain.

### RT-18: CHANGELOG gate in release workflow

The release workflow fails fast (before any publish step) if the CHANGELOG does not contain a section matching the tag being released. This honours B4 and prevents the failure mode where a tagged release ships without user-visible release notes.

Seeds: n/a. Maps to B4.

> **Gap:** No CHANGELOG.md exists. No `check-changelog` step. Status SPECIFICATION_READY — the script is trivial (`grep -q "^## \[$TAG\]" CHANGELOG.md`) but the file and gate both have to be written.

---

### RT-19: Critical-CVE gate via trivy/grype

The release workflow runs `trivy image --severity CRITICAL --exit-code 1` (or equivalent grype invocation) against the final container image, and fails the release if any Critical CVE with a known fix is present. Honours S4.

Seeds: n/a. Maps to S4.

> **Gap:** No scan step exists. No `tests/ci/cve-gate.test.ts` proving the gate blocks on a deliberately vulnerable base image. Requires image to have been built first, but runs before publish.

---

### RT-6: CI pipeline retry + halt-clean

The release workflow retries transient failures (npm 5xx, GHCR push timeout, Sigstore Fulcio outage) with bounded backoff, but halts cleanly — **no partial state** — if a step ultimately fails. Specifically: an unsigned image must not be left published under its final tag. This is the pre-mortem-derived O5 behaviour.

Seeds: DRT-1 (partial). Maps to O5.

> **Gap:** No retry logic. No rollback/cleanup step that deletes a pushed-but-unsigned digest. No `tests/ci/release-halt-clean.test.ts`.

---

### RT-1: Bun version pinning *(TN6 resolution)*

A `.bun-version` file at the repo root is the single source of truth for the Bun toolchain version. CI jobs fail if the invoked Bun does not match. Upgrading Bun becomes a deliberate release-notes-worthy event. This is the load-bearing prerequisite for reproducible binary builds (T5) and for the SLSA provenance to be reproducible by downstream verifiers.

Seeds: DRT-4 (partial). Maps to T3, T5.

> **Gap:** No `.bun-version` file. Release workflow has no `bun-version-file:` input. No `tests/ci/bun-pin.test.ts` asserting the invoked-version match.

---

### RT-2: Dual JSON Schema URL scheme *(TN7 resolution)*

Two JSON Schema URLs are published and kept in lockstep: `.../v0/mock.json` (rolling latest) and `.../v0.N/mock.json` (per-minor frozen snapshot). `mockstar init` writes the **per-minor URL** into generated mock files by default. A deprecated per-minor URL must remain served for at least one more minor (extends O4 deprecation policy to schema URLs).

Seeds: DRT-6 (high confidence). Maps to T6, B3, O4.

> **Gap:** No schema hosting yet. No `docs/SCHEMA-HOSTING.md`. No `mockstar migrate --schema` CLI command. The schema itself exists in-repo; publishing surface and CDN caching headers do not.

---

### RT-7: ESM-only package shape with Jest 29 escape hatch

`package.json` declares `"type": "module"`, the `exports` map lists `"types"` first in every condition branch, ships `.d.ts` declarations, and `bun add -D mockstar` + `import { launch } from 'mockstar'` resolves zero-config in Jest 30, Vitest, and `bun:test`. Jest 29 users get a runnable `examples/sdet-jest29/` demonstrating the `transformIgnorePatterns` + `--experimental-vm-modules` workaround.

Seeds: DRT-7 (high confidence). Maps to T1.

> **Gap:** Current `package.json` does not have a formal `exports` map with types-first ordering. No packaging test asserts the resolution order. No `examples/sdet-jest29/` exists.

---

### RT-8: Multi-arch container (linux/amd64 + linux/arm64)

The GHCR container image is published as a manifest list supporting both `linux/amd64` and `linux/arm64`, built in a single Buildx invocation so the digest covers both arches. Consumers on Apple Silicon and ARM-based CI do not need emulation.

Seeds: n/a. Maps to T2.

> **Gap:** No Dockerfile beyond a minimal one. No Buildx-based multi-arch build in CI. No `tests/docker/multiarch-smoke.test.ts` running the smoke test under both arches.

---

### RT-9: Standalone binary, 4 targets, ≤150 MB each

`bun build --compile` produces four target binaries (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`); each compressed binary is ≤150 MB (relaxed from 100 MB per TN2); all four execute `--version` successfully. Two independent CI runs on the same tag produce bit-identical binaries (reproducibility, depends on RT-1).

Seeds: DRT-4 (medium confidence). Maps to T3, T7.

> **Gap:** No `scripts/build-binaries.ts`. No size test. No smoke test across the matrix. No diffoscope-based reproducibility test.

---

### RT-10: Helm chart pushed to GHCR as OCI artifact

The release workflow runs `helm push ./charts/mockstar-<version>.tgz oci://ghcr.io/<org>/charts` on stable tags. The chart is signed by cosign (RT-4 pattern) and discoverable via `helm pull oci://...`.

Seeds: n/a. Maps to T4.

> **Gap:** No `charts/mockstar/` directory. No `Chart.yaml`. No `helm push` step.

---

### RT-11: Labeled ConfigMap for tenant content *(TN5 resolution)*

The Helm chart mounts all ConfigMaps carrying the label `mockstar.dev/tenant=<name>` into the running pod. Tenant content is **not** templated by the chart — teams apply their own labeled ConfigMaps separately (kustomize overlay or side-chart). `helm upgrade` and `helm rollback` leave the labeled ConfigMaps untouched.

Seeds: DRT-3 (medium confidence). Maps to O1, O2, U3.

> **Gap:** No chart exists. The label-selector contract has to be written into `values.yaml` and the deployment template. No `tests/helm/upgrade-preserves-tenants.test.ts`.

---

### RT-12: Helm chart probes + Prometheus `/metrics`

The chart's deployment template wires `livenessProbe` and `readinessProbe` to an HTTP endpoint served by mockstar, and includes an optional `ServiceMonitor` template pointing at `/metrics` for Prometheus scrape. Without this, DevOps cannot operate the chart — rolling upgrades stall without readiness signals.

Seeds: n/a. Maps to O1.

> **Gap:** No chart. No `/health` or `/metrics` endpoint on the mockstar server. Requires coordinated server-side and chart-side work.

---

### RT-13: 5-minute per-persona quickstart smoke test

A `quickstart-smoke` GitHub workflow runs each persona's single-command path end-to-end on a clean runner (Developer: `bunx mockstar init && bunx mockstar ./mocks`; SDET: `npm i -D mockstar` + `launch()` in a Jest test; DevOps: `docker pull && docker run` + curl smoke) and asserts wall-clock < 5 minutes. Runs on every tag and nightly on `main`.

Seeds: DRT-5 (medium confidence). Maps to B2.

> **Gap:** Workflow does not exist. None of the three commands work today end-to-end.

---

### RT-14: `mockstar init` scaffold command

`bunx mockstar init` (and `mockstar init` from the installed binary) scaffolds a starter directory tree: `mocks/example.json` with `$schema` pointing to the per-minor URL (per RT-2), a README fragment, and a minimal `mockstar.config.json`. Idempotent — running twice does not overwrite existing files.

Seeds: n/a. Maps to U1.

> **Gap:** No `src/cli/commands/init.ts`. No `tests/cli/init.test.ts`.

---

### RT-15: `docs/SDET.md` + four working example directories

`docs/SDET.md` documents the supported framework matrix with version floors. Four runnable example directories — `examples/sdet-jest30/`, `examples/sdet-jest29/`, `examples/sdet-vitest/`, `examples/sdet-bun-test/` — each contain a minimal `package.json`, one test file using `launch()` + journal assertions, and pass in CI.

Seeds: n/a. Maps to U2.

> **Gap:** `docs/SDET.md` does not exist. None of the four example directories exist.

---

### RT-16: `CONTRIBUTING.md` + `docs/TEAM-WORKFLOW.md`

`CONTRIBUTING.md` covers local dev setup, the test matrix, and PR conventions. `docs/TEAM-WORKFLOW.md` documents the forking / per-team repo / PR-template pattern for internal adoption without upstream changes. Together they close U3.

Seeds: n/a. Maps to U3.

> **Gap:** Neither file exists.

---

### RT-17: SemVer + deprecation policy documentation

`docs/VERSIONING.md` codifies the v0.x contract: public API may break on minor; patch is always safe; deprecations announced one minor ahead; per-minor schema URLs kept alive for one additional minor (ties to RT-2). README has a prominent "v0.x may break on minor" banner.

Seeds: n/a. Maps to B3, O4.

> **Gap:** No `docs/VERSIONING.md`. README has no banner. Status SPECIFICATION_READY — the decisions are locked in m1; only authoring remains.

---

## Solution Space

### Option A: Minimum-viable, npm-only

Ship only the npm package + a GitHub release with binaries; skip container, Helm, SBOM, SLSA. Developers and SDETs are addressed; DevOps is punted.

- **Satisfies:** RT-3, RT-4 (partially), RT-7, RT-13 (partially), RT-15, RT-18
- **Gaps:** RT-8, RT-10, RT-11, RT-12, RT-2 (no schema publishing), RT-9 (no binary matrix)
- **Reversibility:** `TWO_WAY` — can add targets later
- **Verdict:** **Rejected** — violates the locked decision to ship all four publishing targets in the first cut, and leaves the DevOps persona completely unaddressed.

### Option B: Full parallel — everything on every tag

Run cosign, SBOM, SLSA, multi-arch container, Helm push, binary matrix, and CVE gate on every tag including pre-releases.

- **Satisfies:** all 19 RTs
- **Gaps:** none
- **Reversibility:** `REVERSIBLE_WITH_COST` — can be toned down later
- **Verdict:** **Rejected** — violates TN1 resolution (stable-only SLSA segmentation). Running SLSA's reusable workflow on every alpha/beta tag is wasteful, causes TUF root-of-trust proliferation, and the SLSA attestation is load-bearing for supply-chain verifiers who explicitly want pre-release noise filtered out.

### Option C: Phased alpha → beta → stable

Alpha: npm only. Beta: add container + Helm + signing. Stable (v0.1.0): add SLSA + binaries + CVE gate.

- **Satisfies:** all 19 incrementally
- **Gaps:** none at stable
- **Reversibility:** `TWO_WAY` per phase
- **Verdict:** **Rejected** — delays the full cross-persona promise; creates a docs split-brain where the README claims "4 publishing targets" but early alphas only ship two; SDET persona (npm) gets shipped before DevOps persona has any artifacts at all, inflating perceived readiness.

### Option D: Full four-target with TN1 stable-only SLSA segmentation ← **Recommended**

Ship all four publishing targets from the first tag. Apply **per-release-type segmentation** (RT-5): stable tags get the full surface (cosign + SBOM + SLSA + CVE gate); pre-release tags get cosign + SBOM but not SLSA; CVE gate is mandatory on every tag. Binary size ceiling relaxed to 150 MB (TN2). Helm chart ships only the mockstar deployment + labeled-ConfigMap selector pattern (TN5); tenant content is out-of-chart. Schema URL scheme is dual (TN7). Jest 29 supported via documented `examples/sdet-jest29/` escape hatch (TN4).

- **Satisfies:** all 19 RTs
- **Gaps:** none
- **Reversibility:** `REVERSIBLE_WITH_COST` overall, with one `ONE_WAY` sub-step — **published version numbers cannot be reclaimed** once tagged, so a botched first stable release consumes `v0.1.0` permanently. Mitigation: ship stable only after `v0.1.0-rc.N` exercises the full pipeline.
- **Verdict:** **Recommended.** Only option that satisfies all 19 RTs *and* honours every m2 tension resolution. Tension validation: 7/7 CONFIRMED.

---

### Binding Constraint: RT-3 (OIDC wiring)

**Why binding:** OIDC wiring is the prerequisite for the entire signing surface. Without `id-token: write` + npm Trusted Publishing registration + Sigstore Fulcio trust on the repo, eight downstream RTs cannot close:

```
RT-3 (OIDC wiring)
├── RT-4  cosign + CycloneDX SBOM attestation
├── RT-5  release-type detection (gates SLSA on stable)
├── RT-6  CI retry + halt-clean (built around the signing pipeline)
├── RT-8  multi-arch container (signed at publish)
├── RT-9  standalone binary (SLSA-attested)
├── RT-10 Helm chart push (cosigned)
├── RT-18 CHANGELOG gate (front-end to the same workflow)
└── RT-19 CVE gate (runs before publish, inside the same workflow)
```

It is also the hardest-to-verify-right the first time: OIDC audience/subject mismatches fail silently. Dev velocity for the rest of m4 depends on closing RT-3 first, so m4-generate should tag artifacts satisfying RT-3 with `"priority": "binding"` and generate them first while context is freshest.

> **Note on blocking_dependencies from m2 vs binding_constraint:** m2's blocking_dependencies (TN6: T5→T3; TN7: T6→B3) measure *within-tension* blocking — narrow scope. The binding constraint measures *whole-feature leverage* — the one RT whose resolution unblocks the widest downstream chain. These are complementary, not competing: TN6 and TN7 are dealt with by RT-1 and RT-2 (both of which m4 can start in parallel with RT-3), while RT-3 gates the eight-RT signing surface.

---

## Tension Validation

Each resolved tension from m2 is validated against the recommended Option D:

| Tension | Resolution | Honoured by Option D? | Note |
|---|---|---|---|
| TN1 | Segment SLSA to stable-only | **CONFIRMED** | RT-5 gates SLSA L3 on stable-only release type detection |
| TN2 | Relax binary ceiling to 150 MB | **CONFIRMED** | RT-9 uses the 150 MB ceiling |
| TN3 | Package-manager-native verification per persona | **CONFIRMED** | RT-13 per-persona quickstart uses native install; cosign explicit only in DevOps docs |
| TN4 | Supported frameworks + Jest 29 escape hatch | **CONFIRMED** | RT-7 and RT-15 include `examples/sdet-jest29/` |
| TN5 | Segment tenant content outside chart | **CONFIRMED** | RT-11 adopts the `mockstar.dev/tenant` label selector; chart does not template tenant content |
| TN6 | Pin Bun + record in provenance | **CONFIRMED** | RT-1 pins Bun in `.bun-version` and the SLSA attestation records the digest |
| TN7 | Dual-URL scheme with per-minor default | **CONFIRMED** | RT-2 publishes both URLs; RT-14 `init` writes per-minor URL by default |

Result: **7/7 CONFIRMED, 0 REOPENED.** Option D is internally consistent with every m2 tension resolution.

---

## Pre-mortem notes (for m2 and beyond)

The interactive pre-mortem was deferred in iteration 1 (session continuation). Three failure stories were modeled as the pre-mortem proxy:

1. **Could have seen coming — CI secret leak.** A long-lived `NPM_TOKEN` or cosign keypair stored as a repo secret leaks through a workflow log, PR fork action, or compromised dependency. → Addressed by B1 (no long-lived tokens).
2. **Surprise — `bun --compile` binary bloat.** The standalone binary crosses 150 MB compressed after we add one dependency, bounces off corporate download proxies, and the 5-minute promise (B2) is broken for anyone behind a restrictive proxy. → Addressed by T7.
3. **Someone else's action — Sigstore Fulcio outage.** Sigstore has a 20-minute outage mid-release, the sign step fails, and we either retry (O5) or leave an unsigned artifact in GHCR to be signed later (forbidden by S1). → Addressed by O5 with explicit "halt cleanly, no partial state" requirement.

A proper interactive pre-mortem should run in a future iteration before m4-generate.
