# Runbook: restore a single tenant

**When:** accidental deletion or corruption limited to one tenant.
**Owner:** platform on-call. **Exercised:** not yet (requires a staging restore rehearsal, Phase 7).

1. Restore the database point-in-time copy to a **separate** instance (never over production).
2. Export the tenant's rows from the copy (every table has `tenant_id`; `pnpm check:schema` lists the exceptions) with a tenant-scoped dump.
3. Object storage: restore `assets/{tenant}/...` and `releases/{tenant}/...` object versions for the window.
4. Import into production inside a maintenance window for that tenant only (kill switch engaged for the tenant first).
5. **Restore rule (spec 17.6):** move every restored publication in `scheduled`/`dispatching`/`processing` to `held` and reconcile each against remote history before release, so a restore cannot republish.
6. Re-apply pending deletion requests for the tenant (deletions requested after the restore point).
7. Verify: cross-tenant harness on staging against the restored data; the tenant's owner confirms; release the kill switch.
