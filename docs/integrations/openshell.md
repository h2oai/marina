# OpenShell sandboxes (experimental)

Marina can run Code Mode work in [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandboxes,
alongside Flywheel and Marina's own container runner. OpenShell is optional: Marina never installs
it, and with nothing configured it is off.

## What OpenShell adds

- A sandbox per entity, isolated by OpenShell (Landlock, seccomp, a supervisor outside the
  workload).
- Network policy per program: a request the sandbox's policy does not allow is held, and OpenShell
  drafts a rule for it.
- Marina turns each drafted rule into a **challenge** for a person (the requester's owner or an
  operator). Approving it approves that rule in OpenShell; nothing waits meanwhile, and the agent
  retries when told. Marina stays the only approver.

## Connect a gateway you run

Run an OpenShell gateway yourself (loopback, mutual TLS, `OPENSHELL_TELEMETRY_ENABLED=false`),
then point Marina at it and its client bundle:

```bash
MARINA_OPENSHELL_URL=https://127.0.0.1:17670
MARINA_OPENSHELL_CA=/path/to/ca.crt
MARINA_OPENSHELL_CERT=/path/to/client/tls.crt
MARINA_OPENSHELL_KEY=/path/to/client/tls.key
# optional
MARINA_OPENSHELL_IMAGE=docker.io/library/python:3.13-slim
```

Restart Marina, then in Code Mode:

```text
code sandbox providers          # openshell is listed with what it can do
code sandbox start provider:openshell
code sandbox use openshell      # this session's finite commands now run there
code run python3 -m pytest
```

Commands, file reads and writes, `code service publish` and hibernate/resume go through the
gateway's gRPC API (`src/integrations/openshell/`, no extra dependency). A requested OpenShell
target never falls back to the host. After a restart Marina finds its sandboxes again by label.
Sandbox ownership follows the durable Marina account. Project selection, guest working directories,
and service state are stored separately for each provider; migration 183 preserves existing Flywheel
bindings and adds the provider key. Restarting Marina keeps the running guest and its active project.

Use a guest image that includes the tools your project needs. Its working directory must be usable
by OpenShell's sandbox identity, and executable paths must be permitted by the sandbox policy.
Finite execution requires GNU `timeout` in the guest; Marina uses it to terminate the command's
process group before the gateway deadline. A missing utility fails the guest command explicitly.
An image's implicit volumes also have to satisfy the gateway's volume admission rules. Managed
services accept quoted arguments, for example `code service start web --port 8000 -- python3 -m
http.server 8000`; inspect `code service logs web` and `code service probe web` to verify readiness.

## Limits

- Experimental: verified against OpenShell 0.1.5 with the podman driver.
- Files move through command input and output (OpenShell has no file RPC), up to 8 MiB per transfer.
- Credential injection through OpenShell providers is not wired; use Marina's own model route
  (`MARINA_CODE_CONTAINER_MODEL_API`) or keep keys out of sandboxes.
- An approved rule takes a few seconds to apply inside the sandbox.
