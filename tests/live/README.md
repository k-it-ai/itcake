# Live integration suite

These tests boot the real production artifact (`build/index.js`) and drive
external surfaces that the hermetic `npm test` suite cannot cover. They are
opt-in because they need binaries, fixed ports, and sometimes network
credentials.

```sh
npm run build
npm run test:live
```

`npm test` excludes this directory. `vitest.live.config.ts` runs only this
directory and disables file parallelism so the fixed test ports do not collide.

## What runs

| File | Covers | Skips when |
| --- | --- | --- |
| `browser-e2e.test.ts` | Real Chromium: first-run setup, login, TOTP enable/login, TOTP replay rejection, CSRF origin rejection, client creation, invoice creation, real PDF rendering | Chromium/Puppeteer is unavailable |
| `caddy-tls.test.ts` | Production build behind Caddy over HTTPS: `Secure` session cookie, HSTS, CSRF origin through the proxy | `caddy` is not on `PATH` |
| `cross-key-backup.test.ts` | Backup from host A restored on host B with a different `FIELD_ENCRYPTION_KEY`/`SESSION_SECRET`: plaintext data survives, encrypted credentials fail closed, the server stays healthy | never (uses local SQLite) |
| `agent-smoke.test.ts` | Builds and runs the real Go agent: enroll, check in, receive a dispatched read-only command, report its result | `go` is not on `PATH` |
| `smtp-ethereal.test.ts` | Creates a disposable Ethereal account, saves real SMTP settings, performs STARTTLS/AUTH, sends a message, and verifies via IMAP that CRLF header injection and HTML payloads were sanitized; also checks the loopback-host SSRF guard | the Ethereal account API is unreachable |
| `load.test.ts` | 10 concurrent readers for 2.5s against the production build, the 600/min per-IP API limit, and 20 concurrent writes with unique-id checks | never (local) |
| `telegram.test.ts` | Real `getMe` + `sendMessage` through the uptime test endpoint | `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are unset |
| `anthropic.test.ts` | Saves real AI settings and streams one short model turn through the production SSE endpoint | `ANTHROPIC_API_KEY` is unset |
| `guacd.test.ts` | Real guacd SSH/RDP session through the production WebSocket proxy: token HMAC, one-time session claim, protocol check, display defaults, connect/disconnect lifecycle | `ITCAKE_LIVE_GUACD_HOST` or `ITCAKE_LIVE_RD_HOST` is unset |

## Prerequisites

- Node.js and the repo dependencies (`npm ci`).
- Chromium for Puppeteer: `npx puppeteer browsers install chrome`.
- Caddy for the TLS test: `brew install caddy` (or use the official binary).
- Go for the agent test: `go version` (the test compiles `agent/cmd/agent`).
- Ethereal needs outbound HTTPS to `api.nodemailer.com`, `smtp.ethereal.email`,
  and `imap.ethereal.email`; no account is required.
- Telegram: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for a disposable bot.
- Anthropic: `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_LIVE_MODEL`). The
  test caps the AI budget at $1 and uses the smallest output limit.
- guacd: an existing daemon and a reachable target, both provisioned outside
  the suite (ITCake is bare-metal/VM only; the tests never start containers):
  `ITCAKE_LIVE_GUACD_HOST`, `ITCAKE_LIVE_GUACD_PORT` (default 4822), and
  `ITCAKE_LIVE_RD_HOST`, `ITCAKE_LIVE_RD_PORT` (default 22/3389),
  `ITCAKE_LIVE_RD_USER`, `ITCAKE_LIVE_RD_PASSWORD`. Set
  `ITCAKE_LIVE_RD_PROTOCOL=rdp` for RDP; the default is SSH.

## Notes

- The agent test exposed a real availability issue: a hung macOS `log show` or
  Homebrew `brew list` could block the check-in loop indefinitely, leaving
  server-side commands pending. The agent now bounds event-log, inventory, and
  macOS metrics collection. The test is a regression guard for that bug.
- `cross-key-backup.test.ts` documents the restore contract. A different
  `FIELD_ENCRYPTION_KEY` makes encrypted fields unrecoverable, and a different
  `SESSION_SECRET` also invalidates TOTP recovery-code HMACs. Restore the
  original keys, or re-enroll MFA after a deliberate rotation.
- The Caddy test generates a self-signed certificate, points Caddy at it, and
  validates it explicitly in the Node probes (`ca` + `rejectUnauthorized:
  true`). Only the browser uses Puppeteer's scoped `acceptInsecureCerts`. No
  global TLS disable and no system trust-store change.
- Credential-gated tests read only environment variables; no secrets are
  committed. A live run without credentials reports those files as skipped.
- `guacd.test.ts` caught a guacamole-lite 1.2 integration bug: the library takes
  callbacks as its fourth constructor argument, drops `connection.type` while
  merging, and the app was replacing (not merging) the default display
  settings. The hermetic `tests/unit/guac-proxy.test.ts` pins all three.

Each test creates a `data-test-live-*` directory and removes it on teardown. If
a run is killed, remove the directory manually; it is gitignored.
