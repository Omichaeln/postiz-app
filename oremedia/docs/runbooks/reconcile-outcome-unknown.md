# Runbook: reconcile an `outcome_unknown` publication

**Symptom:** publication in `outcome_unknown` or `held` with reason `outcome_unknown_unresolved`; metric `oremedia.publish.outcome_unknown_age_ms` rising.
**Owner:** publisher; platform on-call if many at once. **Exercised:** not yet (Phase 5 dependency).

Never retry the publish blindly (spec 2.2). The attempt ledger decides:

1. Open the publication's attempts (`publishing.publications.get` → attempts, `publishing.publications.evidence`).
2. If the latest attempt has **no `sentAt`**, the call was never made: the workflow classifies it `retryable_error` itself. If you see this state by hand, re-schedule (`held → scheduled`); a new attempt with a new fencing token is opened.
3. If the attempt has `sentAt`, the platform may have the post. Automatic reconciliation already polled `findRemotePost` at +1 m, +5 m, +15 m, +1 h. Check the remote account manually (provider UI or API) for a post matching the text fingerprint and media at the attempt time.
4. Found: `publishing.publications.reconcile { resolution: 'confirm_published', remotePostId, remoteUrl }` records human confirmation evidence and moves to `published`.
5. Definitely absent: `reconcile { resolution: 'confirm_absent' }` moves to `retry_eligible`; re-schedule when appropriate (same occurrence key, new attempt).
6. Cannot determine: leave held, add a note, and revisit after the provider's processing window; do not schedule a duplicate.
7. Verify: the publication is in a definitive state and no second remote post exists (duplicate detection metric unchanged).
