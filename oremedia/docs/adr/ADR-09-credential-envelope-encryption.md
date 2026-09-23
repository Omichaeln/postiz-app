# ADR-09: Credential envelope encryption and broker isolation

**Status:** Proposed
**Date:** 23 September 2026
**Reversal cost:** Must hold before first channel connect.

## Decision

Tokens are AES-256-GCM encrypted with a per-record data key wrapped by KMS; AAD = `${tenantId}:${channelConnectionId}`.
Only `worker-core` and `worker-ingest` may decrypt (`credentialBroker.withCredentials`); the API process cannot
(KMS IAM). Payloads carry `channelConnectionId` only. A local KMS implementation exists for development and tests;
production uses the cloud KMS named by `KMS_KEY_ID_CREDENTIALS`.
