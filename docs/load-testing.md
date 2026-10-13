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

Results are not published in this repository; measure on your own deployment.
