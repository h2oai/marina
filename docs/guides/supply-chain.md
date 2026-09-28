# Dependency inventories and artifact verification

Marina generates CycloneDX inventories in addition to vulnerability audits. An inventory
lists dependencies; an audit checks known vulnerabilities. Neither replaces the other.

## Generate locally

Install [Syft 1.52.0](https://github.com/anchore/syft/releases/tag/v1.52.0), verify its
published checksum, and put `syft` on your PATH. Alternatively, set `SYFT_BIN` to the
executable's absolute path. CI pins both the scanner version and the installer action.

```sh
bun run sbom
# Optional destination outside the checkout:
bun run sbom /tmp/marina-source.cdx.json
```

The default output is `dist/supply-chain/source.cdx.json` (ignored by Git).
`qualify:release` requires this step to succeed. Generation stages only tracked Bun
lockfiles in a temporary directory. It does not scan local databases, credentials or
installed packages. Coverage validation fails if any external package name/version in
any lockfile is absent, including scoped, transitive, optional and platform packages.

This is a **repository build-input inventory**: the workspace and both extensions,
including development dependencies. It is intentionally broader than any one runtime.
Locally patched dependencies retain their upstream identity; their patch is covered by
the source commit. Downloads outside Bun's lockfiles, bundled desktop runtimes and OS
packages are not covered by this inventory. Dependency completeness cannot be inferred
for those components from a source inventory alone.

## Published evidence

| Workflow | Inventory and signature |
| --- | --- |
| Supply Chain | Builds `marina.tgz` and the source inventory. Main and `v*` tag builds sign SLSA build provenance and an SBOM statement bound to the package digest. PRs produce unsigned artifacts with no signing permissions. |
| Desktop Release | Main/manual and `desktop-v*` builds sign the actual installers and attach the source inventory and verification bundles to build artifacts and draft releases. |
| Trivy Image Scan | Produces an unsigned CycloneDX inventory of the built image alongside its vulnerability report. |
| Deploy EC2 | Scans the exact immutable image selected for deployment (including rollback), then signs its SBOM statement before changing production. |

The image inventory includes scanner-discovered installed libraries and OS packages,
so use it for runtime analysis. The deployment workflow does **not** claim fresh build
provenance for a rollback or infer source identity from `workflow_run`'s default-branch
SHA. Its SBOM signature identifies the scanned image digest and the scanning workflow.

Package signing runs in a separate job that downloads artifacts without executing
repository code. Signing actions are pinned by commit. GitHub's OIDC identity signs
the statements; no long-lived signing secret is stored in this repository. Bundle
artifacts are retained for 90 days; archive them with releases that need longer retention.
Desktop draft releases also retain their uploaded bundles.

## Verify a downloaded package

Set `MARINA_RELEASE_SHA` to the full source commit you expect, then use a current
[GitHub CLI](https://cli.github.com/manual/gh_attestation_verify):

```sh
gh attestation verify marina.tgz --repo h2oai/marina \
  --signer-workflow h2oai/marina/.github/workflows/supply-chain.yml \
  --source-digest "$MARINA_RELEASE_SHA"

gh attestation verify marina.tgz --repo h2oai/marina \
  --signer-workflow h2oai/marina/.github/workflows/supply-chain.yml \
  --source-digest "$MARINA_RELEASE_SHA" \
  --predicate-type https://cyclonedx.org/bom
```

For desktop installers, substitute the filename and `desktop-release.yml`. For a
deployment image, authenticate to its registry and use `oci://REGISTRY/IMAGE@sha256:DIGEST`,
`deploy-ec2.yml`, and the CycloneDX predicate. The deployment signature's source commit
identifies the scanning workflow, not necessarily the historical image source commit.

Pass `--bundle PATH` to use a downloaded verification bundle. A signature verifies
artifact identity and workflow claims; it does not certify freedom from vulnerabilities,
reproducible builds or a particular SLSA assurance level. Local generation cannot create
a GitHub attestation: signing and verification must succeed on a trusted Actions run.
