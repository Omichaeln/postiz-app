# Runbook: certify a channel

**Purpose:** move a provider adapter from `certifiedAt: null` (registry refuses it for tenants) to certified
(spec 14.6). Certification means: sandbox or test-account publish and read-back, refresh and reconnect, rate-limit
behaviour, error fixtures captured, reconciliation proven, metrics fetched. **Owner:** platform engineer with the
platform's developer app. **Exercised:** not yet (blocked: needs each platform's own app and app review).

Release 1 adapters (spec 14.8; decision D-04 still open): `linkedin_page`, `instagram_business` (Facebook Graph),
`facebook_page`, `x` (built as the fourth channel; TikTok is the alternative D-04 may choose). Code lives in
`packages/providers/src/<key>/`; handwritten fixtures in `packages/providers/src/<key>/fixtures/*.json` are served by
`packages/providers/src/testing/fixture-server.ts` through the real `ProviderIO`.

## Procedure (per channel)

1. Create the platform app, request the scopes listed in the adapter's `capability.requiredScopes`, complete app
   review where the platform requires it, and store the client id and secret in the secret manager (Appendix A);
   adapters never read environment variables.
2. Re-derive the pinned API versions from the platform's current docs and update the constant if needed:
   `LINKEDIN_VERSION` (`linkedin_page/adapter.ts`, YYYYMM, sunset after ~12 months), `META_GRAPH_VERSION`
   (`facebook_page/graph.ts`, shared with Instagram), X API v2 base (`x/adapter.ts`).
3. Connect a test account through the connect flow: verify `authorizationUrl` (state echoed; PKCE on X),
   `exchangeCode` (grant, `grantedScopes`, `alternatives` for multi-page/organisation grants, `selectAccount`), and
   `missingScopes` against `requiredScopes`.
4. Publish through the workflow to a test page/account: text only, single image, carousel, video. Confirm the
   `accepted`/`pending` outcome, the `checkStatus` → `ready` → `finalize` → `completed` sequence, and the spec 20.3
   invariant: call `checkStatus` again after `finalize` and observe `completed`, never `ready`.
5. Read back the post by id and through `findRemotePost` (fingerprint scan): prove `found`; delete the post and
   prove `definitely_absent`; break the scan (revoke read scope) and prove `cannot_determine`.
6. Capture every fixture in the table below from the real platform (redact tokens with `redactBody` before saving),
   replacing the handwritten JSON, and re-run `pnpm exec vitest run --project unit packages/providers`.
7. Refresh and reconnect: let the token approach expiry and run `refresh`; revoke the app from the platform side
   and prove `reconnect_required`.
8. Rate limits: drive the platform to a 429 on a read and record the headers; confirm the platform documents the
   429 as not executed for the publish mutation (the adapters classify 429 as `rate_limited` with
   `phase: 'before_send'`). If a platform executes a throttled mutation, change that adapter's `classifyError` to
   return `unknown` for 429.
9. Metrics: fetch post and account metrics at +1h and +24h; check every `nativeName` in `capability.analytics` is
   returned or recorded as `unavailable` (never zero); adjust the metric list to what the platform currently serves.
10. Comments: read a page with `fetchComments` (cursor paging) and reply with `comment`.
11. Record the run in `docs/decisions/DECISIONS.md` (D-04) and set `certifiedAt` in the adapter's `capability.ts` to
    the certification timestamp. Only then does `providerRegistry.get(key)` hand the adapter to tenants.

## Fixtures each adapter needs captured

| Scenario                                 | linkedin_page                                                        | instagram_business                                                | facebook_page                                 | x                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Auth exchange (+ identity, account list) | `auth.json/exchange`                                                 | `auth.json/exchange`                                              | `auth.json/exchange`                          | `auth.json/exchange`                                                 |
| Refresh ok / refresh refused             | `auth.json/refresh_ok`, `refresh_revoked`                            | `auth.json/refresh_ok`, `refresh_revoked`                         | `auth.json/refresh_ok`, `refresh_revoked`     | `auth.json/refresh_ok`, `refresh_revoked`                            |
| Publish success (text)                   | `publish.json/text_success`                                          | n/a (media required)                                              | `publish.json/text_success`                   | `publish.json/text_success`                                          |
| Publish → pending (media processing)     | `publish.json/image_pending`                                         | `publish.json/image_pending`, `carousel_pending`                  | `publish.json/video_pending`                  | `publish.json/video_pending`                                         |
| Pending → processing / ready / failed    | `pending.json/check_*`                                               | `pending.json/check_*`                                            | `pending.json/check_*`                        | `pending.json/check_*`                                               |
| Finalize → completed                     | `pending.json/finalize_completed`                                    | `pending.json/finalize_completed`                                 | n/a (no finalize)                             | `pending.json/finalize_completed`                                    |
| Finalize already completed (20.3)        | `pending.json/check_after_finalize`, `finalize_duplicate_then_found` | `pending.json/finalize_already_published`, `check_after_finalize` | `pending.json/check_completed` (repeatable)   | `pending.json/check_after_finalize`, `finalize_duplicate_then_found` |
| Rejected with a validation body          | `publish.json/rejected_validation`                                   | `publish.json/rejected_validation`                                | `publish.json/rejected_validation`            | `publish.json/rejected_validation`                                   |
| Rate limited with headers                | `publish.json/rate_limited`                                          | `publish.json/rate_limited`                                       | `publish.json/rate_limited`                   | `publish.json/rate_limited`                                          |
| 401 / token expired, revoked             | `publish.json/expired_token`, `revoked_token`                        | `publish.json/expired_token`, `revoked_token`                     | `publish.json/expired_token`, `revoked_token` | `publish.json/expired_token`, `suspended`                            |
| 5xx after send                           | `publish.json/server_error_after_send`                               | `pending.json/finalize_5xx`                                       | `publish.json/server_error_after_send`        | `publish.json/server_error_after_send`                               |
| Timeout after send                       | `publish.json/timeout_after_send`                                    | `pending.json/finalize_hang`                                      | `publish.json/timeout_after_send`             | `publish.json/timeout_after_send`                                    |
| Connection refused before send           | closed loopback port (no fixture)                                    | closed loopback port                                              | closed loopback port                          | closed loopback port                                                 |
| Reconciliation found / absent / cannot   | `reconcile.json/found`, `absent`, `cannot_determine`                 | same                                                              | same                                          | same (+ t.co restoration)                                            |
| Metrics page (post, account)             | `read.json/post_metrics`, `account_metrics`                          | same                                                              | same                                          | same                                                                 |
| Comments page + reply                    | `read.json/comments_page`, `comment_reply`                           | same                                                              | same                                          | same                                                                 |

## Known unverified points to close during certification

- LinkedIn: `organizationAcls` projection and role filter; refresh tokens only for approved partner apps; Posts API
  `q=author` scan ordering and page size; `x-restli-id` on 201; alt text limit 4086; per-member/app throttles.
- Instagram: `alt_text` on containers; creating the CAROUSEL parent before children finish; `views` replacing
  `impressions`; 25 posts / 24 h publishing cap (`content_publishing_limit`, not enforced by the limiter); whether
  the user or the page token is required for publishing under the app's login type.
- Facebook: `alt_text_custom` on `/photos`; multi-photo count limit; post/page insight names after Meta's
  impressions deprecation; renewal of a still-valid long-lived user token via `fb_exchange_token`.
- X: tier-dependent rate limits and access to `search/recent` (replies) and `non_public_metrics`; `POST /2/media/metadata`
  for alt text; APPEND chunk size; bare-domain URL detection in weighted counting.
