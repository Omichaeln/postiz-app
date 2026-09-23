# Phase 0 spikes

| Spike                                                                                  | Status                    | Evidence                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Editor round-trip: fixture document save → reopen → render, pixel diff under threshold | See `editor-roundtrip.md` | Recorded there when run                                                                                                           |
| First-channel feasibility with a real developer app: sandbox publish and read-back     | **Open**                  | Requires platform app credentials the implementing environment does not have. Not fabricated.                                     |
| Temporal namespace (Cloud recommended; self-hosted alternative on Railway)             | **Open**                  | Provisioning requires the user's Temporal Cloud or Railway account. `infra/railway/temporal` holds the self-hosted configuration. |
