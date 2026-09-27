// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export const MEMORY_UNIFICATION_SCHEMA = `
DROP TRIGGER legacy_memory_created;
DROP TRIGGER legacy_memory_deleted;
DROP TRIGGER legacy_memory_source_created;
DROP TRIGGER legacy_memory_source_updated;
DROP TRIGGER legacy_memory_verified;
DROP TRIGGER legacy_memory_link_created;
DROP TRIGGER legacy_memory_link_deleted;
ALTER TABLE memory_note_projections ADD COLUMN version INTEGER;
CREATE VIEW numeric_notes AS
 SELECT n.id,n.entity_name,n.room_id,coalesce(c.content,n.content) AS content,n.created_at,
 coalesce(c.importance,n.importance) AS importance,n.last_accessed,n.note_type,n.pool_id,n.supersedes_id,
 n.recall_count,n.tier,n.confidence,n.verification_status,n.claim_key,
 coalesce(c.id,n.id) AS content_id
 FROM notes n LEFT JOIN memory_note_projections p ON p.note_id=n.id
 LEFT JOIN memory_records r ON r.id=p.record_id
 LEFT JOIN memory_record_versions v ON v.record_id=p.record_id AND v.version=p.version
 LEFT JOIN notes c ON c.id=CASE WHEN p.version IS NULL THEN r.current_note_id ELSE v.note_id END
 WHERE n.entity_name NOT LIKE 'memory:%' AND NOT EXISTS(SELECT 1 FROM memory_record_versions rv WHERE rv.note_id=n.id);
CREATE TRIGGER numeric_handle_no_body BEFORE UPDATE OF content ON notes
 WHEN NEW.content!='' AND EXISTS(SELECT 1 FROM memory_note_projections p WHERE p.note_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'Numeric handles cannot store record content'); END;
`;
