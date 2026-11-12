// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.List;

/**
 * One step the coder took.
 *
 * @param kind one of {@link Wire#CODING_ACTIVITY_KINDS}
 * @param label one line in plain words: "Edit paginate.js"
 * @param path the file, or null
 * @param diff the change as unified-diff body lines (-old, +new, context), capped; or null
 * @param more diff lines left out past the cap, or null
 * @param quiet bookkeeping a UI may hide, or null
 */
public record CodingActivity(
    String kind, String label, String path, List<String> diff, Long more, Boolean quiet) {}
