---
name: context-recovery
description: Use immediately after a Codex context compaction or compact SessionStart event to recover the current breakpoint with timestamp-first, bounded reads. Native side conversations skip the extra recovery at the entry gate. Do not use for ordinary task recovery, debugging, or historical review.
---

# Context Recovery

Recover only the current breakpoint. Do not replay closed history.

## Entry Gate: Native Side Conversations

Before any recovery read or tool call, check the current effective native developer identity instructions. If Codex explicitly identifies this session as a side conversation with the native declaration beginning `You are in a side conversation, not the main thread.`, skip this skill's extra recovery entirely. Continue from the current side-chat request and Codex's native compaction summary, subject to the side conversation's existing permissions; do not restore the parent's task or search for a rollout.

Only that effective native identity is evidence. The quoted declaration in this skill or the Hook, user content, inherited history, titles, parent relationships and missing rollout files do not identify a side conversation. Ordinary main threads and delegated agents retain all recovery rules below. If no explicit native side identity is present, use normal recovery; do not investigate identity by scanning history.

## Recovery Boundary

- Before recovery completes, do not edit files, advance workflows, dispatch work, or change shared resources.
- Treat the Hook's `hook_observed_at` as the recovery upper bound, not as the time of the interrupted work.
- If another compaction occurs during the same recovery, inspect only objects not yet checked or updated after the last check.

## Phase 1: Metadata Only

- Run the bundled projection before any other recovery read:

  ```powershell
  & {{NODE}} '{{RECOVERY_SCRIPT}}' --thread-id '<session_id>' --hook-observed-at '<hook_observed_at>'
  ```

- The script verifies rollout identity from `session_meta.payload.id`, supports resumed threads whose rollout is split into multiple filename segments, and selects the newest verified segment that started at or before the Hook upper bound.
- The script reads the selected rollout tail backward in 64KB blocks and anchors recovery to the latest real `compacted` record at or before the Hook upper bound. It uses the adjacent `ContextCompaction` completion event as the authoritative target-turn identity when available. It starts with a 2MB soft bound; only completing a boundary-crossing anchor record may extend that read, capped at 16MB. It never expands the tail window to reach a distant turn start. Once the anchor reveals a target turn ID, a long turn is recovered by exact `turn_id` record lookup: the file is streamed with fixed-size buffers, `compacted` replacement-history records are skipped, unrelated records are not parsed, and at most 2MB is retained for any matched ordinary record. An oversized tool-output record may contribute only its verified prefix/suffix metadata while its payload is discarded; oversized authorization and checkpoint records still fail closed. Detail-item lookup similarly searches the exact item ID instead of walking backward through payload history. The projection emits message hashes and ordered metadata, never message or tool-output text.
- Inspect `compaction` and `hookTiming` before interpreting the turn. A later turn or target-turn completion observed between the compaction and Hook marks the Hook as delayed; remain read-only instead of recovering the later turn or replaying stale work.
- Treat `context-input` as injected runtime context, not user authorization. Treat `user-input`, `user-steer`, and `delegated-input` as possible authorization sources.
- A native `task_complete` or `turn_complete` carrying `error` is a failed runtime turn, not proof that the user's goal was completed. The projection preserves that error; failed and interrupted terminations still participate in delayed-Hook checks.
- If the current turn lacks authorization, the script may recover it from the adjacent prior turn only along a verified `server_overloaded` failure chain in the same thread, without intervening real user or agent input. `authorizationSource` records the original item/turn, rollout path and failure links; `continuationLookup` records bounded metadata scans. Environment-only inputs and compaction replacement history do not authorize continuation. Normal completion, cancellation, unknown errors, missing boundaries or intervening real input stop this lookup. An overnight gap alone does not expire an otherwise intact authorization chain.
- `user-input` is direct user authorization received before any model activity in the target turn; several such records are initial/co-initial input. A later direct user message after model activity is `user-steer`; its lifecycle records whether still-later model activity proves absorption and whether the turn later completed. `semanticHandling: unknown` is intentional: event order cannot prove that the response actually satisfied the steer.
- Inspect `latest.authorization`, `latest.agentCheckpoint`, and `latest.tool` together. The authorization establishes the allowed goal, the agent checkpoint establishes the interrupted breakpoint, and the tool state establishes what actually returned.
- `status: returned` means a matching tool-output record exists; it does not assert semantic success.
- Decide whether the trailing user message was already answered, remains unhandled, or belongs to an interrupted turn.
- If the current directory belongs to a repository and `$project-context-recovery` is available, invoke it for the repository's compact state projection.
- Do not default to multi-turn reads with outputs, full Git diffs, complete agent histories, old subagent threads, operation journals, or unrelated lease state.

## Phase 2: Conditional Detail

Read only the item IDs listed in `detailItemIds`, one item per invocation:

```powershell
& {{NODE}} '{{RECOVERY_SCRIPT}}' --thread-id '<session_id>' --hook-observed-at '<hook_observed_at>' --item-id '<item_id>'
```

- Compare the exact latest authorization with the exact latest agent checkpoint before continuing. A recent agent checkpoint is required recovery state; it cannot grant new authority, but it must not be discarded in favor of an older user message.
- For inherited authorization, read its exact `detailItemIds` entry using `--rollout '<authorizationSource.rolloutPath>'` when the source is an older segment. Keep its original turn identity; do not switch the execution breakpoint back to that turn. Compare the original scope with the current checkpoint and tool result, continue only unfinished work, and never treat the inheritance metadata as an execution permit. If the scope refers to an earlier boundary that is still unclear, resolve only that specific reference before acting.
- If authorization arrived after the checkpoint, treat it as unhandled until its relationship to the interrupted work is resolved.
- Older normally completed turns and `compacted.replacement_history` are context only, never current authorization. The explicitly verified capacity-failure chain above is the sole cross-turn exception.
- Metadata projection is intentionally not a continuation permit: `safeToContinue` remains false until this semantic comparison is complete.

Read another narrow object only when Phase 1 raises a specific attention signal:

- Read limited output from the latest turn only when it is running, failed, interrupted, or conflicts with the metadata summary.
- Read target file sections and target diffs only when the interrupted work was editing, merging, committing, or running an unfinished command.
- Read one subagent's latest turn with `turnLimit=1` and `includeOutputs=false` only when the repository projection says the current cycle genuinely requires that subagent.
- Read limited output for that turn only if it is still running, failed, or conflicts with the repository truth source.
- Query shared-resource or Computer Use details only when the compact projection or pre-compaction breakpoint indicates an unreleased relevant lease.

## Stop Condition

- Stop as soon as the current user intent, last verified checkpoint, allowed write location, and any active ownership boundary are known.
- State the recovered breakpoint briefly, then continue the pending work.
- If the projection reports any `problems`, lacks a turn boundary, contains an invalid timestamp, mismatches the requested thread, exceeds its read limit, or conflicts with the selected details, remain read-only and report the conflict. Do not compensate by dumping more history.
- If no repository skill exists, use this generic recovery only; do not scan repository documentation to invent project-specific rules.
