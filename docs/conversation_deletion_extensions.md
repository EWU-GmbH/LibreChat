# Conversation Deletion Extensions

This document records custom extensions applied to this fork to ensure full data hygiene when deleting conversations.

## Summary
Enhances the existing `DELETE /api/convos` endpoint to remove not only the conversation and its messages, but also:
- Attached files at conversation level (`conversation.files`)
- Files referenced in message documents (`message.files` – string IDs or objects containing `file_id` / `fileId`)
- Vector embeddings (RAG API `/documents` batch delete)
- Physical storage objects via storage strategy (local, s3, firebase, azure, openai, vectordb)
- Periodic cleanup of orphaned file documents (optional)

## Motivation
Original upstream logic only deleted conversations + messages and (partially) conversation-level files. This allowed:
- Orphaned file metadata in Mongo
- Stale vector embeddings increasing the Vector DB size
- Storage bloat (unused uploaded assets)

## Implemented Changes
| Area | File(s) | Description |
|------|---------|-------------|
| Model | `api/models/Conversation.js` | Added options `skipFileDeletion`, `skipFileCollection`; returns deleted file IDs. |
| Route | `api/server/routes/convos.js` | Extended deletion: collects file metadata, reference check, batch vector delete, strategy physical delete, response field `extendedFileCleanup`. |
| Utilities | `api/server/utils/orphanFiles.js` | Find & delete orphan file docs; scheduler helper. |
| Server Boot | `api/server/index.js` | Optional scheduler activation via ENV var. |
| Tests (skeleton) | `api/server/routes/__tests__/convos.delete.extended.spec.js` | Placeholder test for extended deletion. |
| Tests (skeleton) | `api/server/utils/__tests__/orphanFiles.spec.js` | Placeholder test for orphan cleanup. |

## Environment Variables
| Variable | Purpose | Recommended |
|----------|---------|-------------|
| `FULL_CONVO_DELETE` | Enable extended deletion logic & report. | `1` or `true` in production once verified. |
| `CLEANUP_ORPHAN_FILES_INTERVAL_MIN` | Interval (minutes) for background orphan file cleanup. Omit to disable. | `720` (daily) or leave unset. |

## Deletion Flow (Extended)
1. User triggers `DELETE /api/convos` with `conversationId`.
2. Route (if `FULL_CONVO_DELETE` enabled):
   - Loads `conversation.files` and corresponding file docs.
   - Collects message-level file references.
   - Determines files referenced by other conversations (skips destructive ops for shared files).
   - Batch deletes vector embeddings for embedded files not referenced elsewhere.
   - Deletes physical files (storage strategy) except vectordb already removed via batch.
   - Calls `deleteConvos(user, filter, { skipFileDeletion: true })` which removes conversations + messages (and optionally collects file IDs if needed).
   - Returns JSON including `extendedFileCleanup` structure:
     ```json
     {
       "files": { ... },
       "extendedFileCleanup": {
         "totalFiles": n,
         "referencedElsewhere": [ ... ],
         "vectorDeleted": [ ... ],
         "physicalDeleted": [ ... ],
         "physicalSkipped": [ ... ],
         "physicalErrors": [ {"file_id":"...","error":"..."} ]
       }
     }
     ```
3. Mongo `File` docs are deleted in model layer when not handled by route (or skipped when `skipFileDeletion` is passed and route already processed them).

## Reference Checking
Current route-level reference check examines other conversations' `files` arrays. Full message-level cross-conversation reference checks are performed by the orphan cleanup utility (can be extended into the route if needed for stricter guarantees).

## Orphan File Cleanup
- Scheduler (optional) runs every `CLEANUP_ORPHAN_FILES_INTERVAL_MIN` minutes.
- Logic: Loads all `File` docs → subtracts any referenced in conversations or messages → deletes remaining.
- Safe to leave disabled if extended deletion is reliable.

## Error Handling & Logging
- Vector batch delete 404s (IDs not found) are treated as benign and no longer spam logs (duplicate vectordb deletion attempts skipped).
- Physical deletion errors are captured per file and returned in `physicalErrors` for observability.

## Potential Future Enhancements
- Add message-level reference dedup directly inside route.
- Add embedding deletion to orphan job (batch) for safety net.
- Maintain usage counters per file to allow safe multi-conversation reuse and delayed deletion.
- Convert skeleton tests to full integration tests (mongodb-memory-server + supertest) ensuring regressions are caught.

## Rollback Strategy
To revert to upstream behavior:
1. Remove the extended block in `convos.js` (keep only original deletion logic).
2. Remove added options in `Conversation.deleteConvos` and calls to them.
3. Delete `orphanFiles.js` and scheduler invocation in `index.js`.
4. Unset `FULL_CONVO_DELETE` and `CLEANUP_ORPHAN_FILES_INTERVAL_MIN` environment variables.

## Upstream Sync Notes
When pulling upstream updates:
- Watch for changes in `Conversation.js` and `convos.js` to reapply options or resolve merge conflicts.
- If upstream introduces its own cascade logic, compare flows and possibly consolidate by deprecating this extension.

## Quick Verification Steps
1. Set `FULL_CONVO_DELETE=1`.
2. Upload file, attach to chat, embed (ensure `embedded:true`).
3. Delete chat → verify response has `extendedFileCleanup.vectorDeleted` containing file ID.
4. Confirm Mongo `File` document removed (unless shared) and vector record gone (RAG API query returns 404/empty for that file).
5. Optional orphan scan: run manually via Node REPL `require('~/server/utils/orphanFiles').cleanupOrphanFiles({ app: require('~/server') , dryRun:true })` (adjust path usage as needed).

---
Document version: 1.0  
Author: Internal fork customization  
Date: 2025-08-19
