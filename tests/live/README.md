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

## Prerequisites

- Node.js and the repo dependencies (`npm ci`).
- Chromium for Puppeteer: `npx puppeteer browsers install chrome`.
- Caddy for the TLS test: `brew install caddy` (or use the official binary).
- Go for the agent test: `go version` (the test compiles `agent/cmd/agent`).

## Notes

- The agent test exposed a real availability issue: a hung macOS `log show` or
  Homebrew `brew list` could block the check-in loop indefinitely, leaving
  server-side commands pending. The agent now bounds event-log, inventory, and
  macOS metrics collection. The test is a regression guard for that bug.
- `cross-key-backup.test.ts` documents the restore contract. A different
  `FIELD_ENCRYPTION_KEY` makes encrypted fields unrecoverable, and a different
  `SESSION_SECRET` also invalidates TOTP recovery-code HMACs. Restore the
  original keys, or re-enroll MFA after a deliberate rotation.
- The Caddy test uses Caddy's internal CA with `skip_install_trust`, and the
  browser ignores the local certificate. No system trust store is modified.
- Tests that need live credentials (Telegram, Anthropic, Ethereal) can be added
  behind an environment gate; none are committed with secrets.

Each test creates a `data-test-live-*` directory and removes it on teardown. If
a run is killed, remove the directory manually; it is gitignored.
