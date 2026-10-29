# Contributing to ITCake

ITCake is open source under AGPL-3.0-only. Bug reports, documentation fixes,
tests, and small, focused improvements are welcome. Larger features and
architectural changes should start as an issue so scope, security, and the
self-hosted design can be discussed before you invest time.

## Before you start

- Search existing issues and pull requests.
- For a bug, include the version or commit, deployment shape, reproduction
  steps, expected vs actual behavior, and relevant logs. Redact secrets,
  customer data, and database contents.
- For a feature, describe the use case and why the current behavior is not
  enough.
- For a security issue, do **not** open a public issue. Use GitHub's private
  vulnerability reporting:
  <https://github.com/k-it-ai/itcake/security/advisories/new>

## Pull requests

- Keep the change focused: one concern per pull request.
- Add or update tests for behavior changes. Bug fixes should include a
  regression test.
- Run `npm run check`, `npm test`, and `npm run build` before opening the pull
  request. For deployment or live-integration changes, also run
  `npm run test:live` with the prerequisites in
  [`tests/live/README.md`](tests/live/README.md).
- Update documentation when behavior or configuration changes.
- Do not include secrets, production databases, customer data, or generated
  artifacts.
- By contributing, you agree that your contribution is licensed under
  AGPL-3.0-only.

## Review and scope

ITCake is maintainer-led. There is no support SLA and no guaranteed review
time. Changes that broaden the attack surface, add a hosted dependency, or
conflict with the bare-metal/self-hosted design may be declined even if they
are technically sound. Discuss large changes in an issue first.

## Code style

Match the existing structure, naming, and conventions. The application is
TypeScript/SvelteKit with Vitest; the agent is Go. Keep comments purposeful and
avoid unrelated refactors in a bug-fix pull request.
