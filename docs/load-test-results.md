# Load Test Results

> ⚠ **Captured 2026-02 (Bun 1.3.9).** These numbers predate several substrate refactors — civic substrate (single blended standing replacing per-feature scoreboards), crews, the chronicle layer, and the resolver/watcher loop. They remain useful as an order-of-magnitude reference for the WebSocket + command-queue path, but specific timings should be re-measured before being quoted.

Tested on macOS Darwin 24.6.0, Bun 1.3.9, single-threaded server.

## Test 1: 100 Connections, 3 cmd/s each (30s)

| Metric            | Value       |
|-------------------|-------------|
| Connections       | 100/100     |
| Total commands    | 8,900       |
| Errors            | 0           |
| Throughput        | 296.6 cmd/s |
| Connect time p50  | 15.1ms      |
| Connect time p95  | 61.1ms      |
| Connect time p99  | 61.5ms      |
| Round-trip p50    | 2.0ms       |
| Round-trip p95    | 8.6ms       |
| Round-trip p99    | 11.4ms      |
| Server heap       | 9.7MB       |
| Server RSS        | 92.6MB      |

## Test 2: 200 Connections, 5 cmd/s each (30s)

| Metric            | Value        |
|-------------------|--------------|
| Connections       | 200/200      |
| Total commands    | 29,644       |
| Errors            | 0            |
| Throughput        | 988.0 cmd/s  |
| Connect time p50  | 60.4ms       |
| Connect time p95  | 75.3ms       |
| Connect time p99  | 76.5ms       |
| Round-trip p50    | 2.6ms        |
| Round-trip p95    | 12.0ms       |
| Round-trip p99    | 18.3ms       |
| Server heap       | 11.7MB       |
| Server RSS        | 114.8MB      |

## Summary

- Server handles 200+ concurrent WebSocket connections with zero errors
- Throughput scales linearly: ~300 cmd/s at 100 connections, ~1000 cmd/s at 200
- Round-trip latency stays well under 20ms even at p99 under heavy load
- Memory usage is modest: ~12MB heap, ~115MB RSS at peak
- Connection establishment is fast: p95 under 80ms even with 200 simultaneous connections
- Exceeds the target of 100+ concurrent connections with <100ms p95 latency
