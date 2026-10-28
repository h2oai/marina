// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// A calc worker whose module load never finishes: it never reports ready and
// never answers.
declare const self: Worker;
self.onmessage = () => {};

export {};
