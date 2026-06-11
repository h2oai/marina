# Web Chat Display Modes

The dashboard web chat now supports two rendering modes that share a common
perception parser but diverge in presentation.

- **Compact (default)** mirrors the existing ANSI-derived layout. Messages are
  rendered as minimal monospace lines so the view matches the low-bandwidth log
  other surfaces consume. This mode preserves the current token footprint for
  agents or power users that rely on dense output.
- **Rich** groups perceptions into timeline blocks with speaker badges,
  timestamps, and structured room summaries. Movement/system noise is visually
  softened, while room descriptions render as readable sections with chips for
  exits, objects, and occupants.

Implementation notes:

- `handlePerception` now stores the full perception payload alongside the
  ANSI-formatted text when appending chat messages. Renderers read from the same
  message store, so switching modes never replays history or requests new data.
- A shared parser extracts structured fields (speaker name, quoted text, room
  metadata) from the perception's `data` object or, when necessary, from the
  ANSI-stripped text. Compact mode simply reuses the original HTML; rich mode
  uses the structured fields to build semantic UI.
- The toggle state persists in `localStorage` (`marina-chat-mode`). Users can
  flip modes without affecting other clients or server output. Agents that
  consume the WebSocket stream keep receiving the same minimal payload.

This design keeps the machine-facing contract stable while giving humans a
readable, modern timeline when they opt in. Future enhancements (filters,
threading) can build on the shared perception parser without touching the
low-bandwidth compact view.
