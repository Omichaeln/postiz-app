# Phase 0 spikes

| Spike                                                                                  | Status                  | Evidence                                                                                                                          |
| -------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Editor round-trip: fixture document save → reopen → render, pixel diff under threshold | **Verified**            | `editor-bake-off.md` (round trip row): `apps/worker-render/src/roundtrip.integration.test.ts`, 0 pixels differ on both fixtures   |
| Editor bake-off on two fixture brands (Konva; Polotno not applicable)                  | **Verified, gaps open** | `editor-bake-off.md`: shaping, direction, fonts, overflow, protected elements, determinism, keyboard; three rendering gaps open   |
| First-channel feasibility with a real developer app: sandbox publish and read-back     | **Open**                | Requires platform app credentials the implementing environment does not have. Not fabricated.                                     |
| Temporal namespace (Cloud recommended; self-hosted alternative on Railway)             | **Open**                | Provisioning requires the user's Temporal Cloud or Railway account. `infra/railway/temporal` holds the self-hosted configuration. |
