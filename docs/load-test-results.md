# Load testing

Measure the revision, runtime, hardware and workload you intend to deploy. The repository includes
WebSocket load and churn harnesses:

```bash
bun run soak
bun run soak:churn
```

Record the source revision, configuration, command rate, connection count, latency, errors and
resource usage with each run. See the [testing guide](guides/testing.md) for the broader validation
workflow and `test/load/` for the harness controls.

Historical qualification results are maintained in the private `marina-internal` repository at
`docs/research/qualification/load-test-results-2026-02.md`.
