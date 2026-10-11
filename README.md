# Relay

A copy trading workspace with a midnight palette, locally hosted typography, and clear source/follower execution tracking.

## Run locally

Requires Node.js 22.13 or newer (Node's built-in SQLite is used).

1. Back up `backend/config.json`, `backend/copy_trading.db` (including WAL/SHM files while running), `backend/copied_orders.json`, `backend/watchlists.json`, and `backend/.keys/`. Stop the old process before upgrading.
2. In `backend`, run `npm ci --ignore-scripts` and `npm run build`.
3. Copy `.env.example` to `.env`. Set a unique `APP_ADMIN_PASSWORD` of at least 16 characters. Never commit this file. `npm start` loads it; direct `node server.js` does not.
4. Run `npm start` and sign in at `http://localhost:3000` with the administrator password. Authentication no longer trusts `X-User-Id` or browser local storage.

Use `OFFLINE_MODE=true` to prevent startup broker connections and instrument downloads. Offline mode has no synthetic market quotes; paper market orders require a recent real quote. It is not a substitute for disconnecting live accounts during development. Tests use a separate temporary data directory and mocked brokers, never the real account configuration.

The dashboard setup checklist links to Accounts and Copy Setup. New copy links start disabled. Review source/follower accounts and quantity multipliers before enabling and saving; enabling live followers opens a review dialog. Paper Practice only accepts connected paper accounts, and the server prevents paper sources from copying into live followers. Live order tickets identify the account and show a review before submission.

Orders contains recent execution activity grouped by source order and follower, with filled quantities and broker-check guidance. Server connectivity, startup offline mode, live broker connections, and quote freshness are displayed separately. Unavailable quotes have no receipt timestamp. Details, position conversion, and SL / Target controls are disabled until those features are implemented; manage protective orders in the broker application.

## Security and migration

- Previously embedded SSH passwords have been removed from 73 scripts. **Rotate all previously exposed SSH/broker credentials and remove old sensitive logs/backups yourself**; code changes cannot revoke credentials already copied elsewhere.
- All runtime data defaults to `backend`. Optionally set `COPY_TRADING_DATA_DIR` to a persistent, private directory outside OneDrive/web roots. Back up its encryption key with the data. Do not change `ENCRYPTION_KEY` without a deliberate migration: existing credentials would become unreadable.
- Credentials are encrypted using AES-256-GCM. If `ENCRYPTION_KEY` is unset, a random installation-specific key is created in `.keys/ENCRYPTION_KEY`. Restrict that directory using OS permissions (Windows ACLs require your configuration).
- Legacy CBC credentials require the *original* key in `LEGACY_ENCRYPTION_KEY`. With that key configured, run `node --env-file-if-exists=.env scripts/migrate-credentials.js` after backing up. Plaintext credentials are also re-encrypted. Corrupted or unreadable configuration is rejected, never silently replaced.
- Existing administrator data remains under `usr_default`. Verified Firebase identities use Firebase UID, not email/phone supplied by the browser. Old mock-login users are deliberately not auto-linked; migrate ownership only after verifying the actual owner.
- Optional Google sign-in needs the `firebase` configuration object (`apiKey`, `authDomain`, `projectId`, `appId`) in configuration and an enabled Firebase provider. The server verifies signed ID tokens. Sessions expire after eight hours and are invalidated on restart/logout; Firebase revocation is not continuously checked during an existing application session.
- Webhooks require `WEBHOOK_SECRET` (32+ characters) via `X-Webhook-Secret` or a `secret` query parameter. Query secrets can appear in reverse-proxy logs; prefer the header. Payloads only trigger a fresh broker order-book check, not direct trade submission.
- Use HTTPS and `COOKIE_SECURE=true` outside localhost. Run **one application process/PM2 instance**, not cluster mode: account configuration, sessions, and polling coordination are single-process. No CORS access is enabled.

## Order safety

- Orders are durably queued, claimed once, and given broker correlation references. `ACCEPTED` means submitted, not filled; completion is checked against the broker order book.
- Interrupted/ambiguous orders become `RECONCILE_REQUIRED`. They are never blindly retried. Confirm the actual broker position/order manually if correlation cannot resolve the outcome (some brokers may not echo tags).
- Failed/expired zero-fill jobs can be explicitly retried from the execution queue after server validation. Partially filled failures are deliberately blocked: review the remaining exposure before placing a separate remainder order. No automatic replacement after partial cancellation is attempted.
- Copying occurs only from confirmed cumulative fills. Disabled mappings, duplicate links, self-copying, and cycles are rejected/ignored as appropriate. Historical fills are baselined on new mapping activation; changing mappings while orders are still open requires operator review.
- Exit requests are checked against fresh positions and cannot intentionally exceed the current position. Orders placed concurrently outside this app can still change broker exposure between validation and execution; not all brokers provide native reduce-only guarantees.
- Paper accounting uses full cash/short collateral, not broker-specific leverage, fees, taxes, or slippage. Limit orders wait for a crossing recent quote. It is a simulator, not a broker reconciliation ledger.

## Quotes and contracts

Instrument masters refresh every six hours. Searches/options use actual, unexpired contracts and exchange-scoped symbols/tokens. No fabricated index ticks, market depth, option prices, OI, volume, or Greeks are displayed as live data. Unavailable fields are explicit; quotes older than 60 seconds are stale. Derivative historical candles remain unavailable instead of showing synthetic prices. Market-open labels are schedule estimates, not an exchange-status feed.

Broker order tags and Motilal modification payloads follow the [Angel One order documentation](https://smartapi.angelone.in/docs) and [Motilal Oswal API documentation](https://invest.motilaloswal.com/moAPI/APIDocumentation/Introduction). Broker-connected behavior still needs sandbox validation.

## Validate and deploy

Run `npm test`, `npm run build`, and `npm audit` in `backend`. Tests cover authentication/ownership, persistence, encryption, queue concurrency/recovery, copy deduplication, validation, and paper accounting.

`backend/deploy.js` builds a complete runtime manifest including every service and `package-lock.json`. Set `VPS_SSH_*` and `VPS_REMOTE_ROOT`; invocation without `--execute` only validates the manifest. Explicit `--execute` uploads files and runs `npm ci --omit=dev --ignore-scripts` before PM2 restart. It does not upload credentials or runtime state. Provision directories, Node 22.13+, environment variables and the single-instance PM2 process first. Back up and stop the old app before uploading: this in-place deployment is not transactional and has no automatic rollback. SSH tunnelling is opt-in and requires separately configured credentials.

No live trades or deployment are performed by the regression suite. A supervised broker sandbox/paper validation remains necessary before enabling live copying.
