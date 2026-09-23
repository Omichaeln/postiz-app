# Runbook: engage the tenant/brand kill switch

**When:** suspected unauthorised or runaway autonomous publication, a compromised mandate, or a provider incident where publishing must stop now.
**Owner:** tenant owner/admin (their own tenant) or platform on-call under a support session. **Exercised:** locally by integration test (`operations.integration.test.ts`); not yet in production.

1. Engage: `operations.killSwitch.set { scope: 'release_dispatch', brandId | null, engaged: true, reason }`. Tenant-wide (`brandId: null`) or one brand. Effect is immediate: `evaluateRelease` fails `kill_switch_off` and moves due publications to `held` with reasons; nothing is dropped.
2. For agents: `scope: 'agent_starts'` blocks new agent runs; running runs finish or hit their deadline.
3. The action is audited (`kill_switch.engage`) with the reason; tell the brand's publishers.
4. Release: `engaged: false` with a reason. Held publications stay held until a person re-releases each one; they are not auto-released.
5. Verify: audit query shows engage/release pairs; no publication moved to `published` while engaged.
