# ITCake RMM Agent

Static Go binary that checks in with an ITCake server over HTTPS and executes
signed commands. Cross-compiles to macOS, Linux, and Windows (amd64 / arm64).

## Building

```sh
# Current host only
npm run build:agent          # → data/agent-binaries/itcake-agent-<os>-<arch>

# All platforms
npm run build:agent:all      # → data/agent-binaries/itcake-agent-{darwin,linux,windows}-{amd64,arm64}[.exe]

# Or via the Makefile
cd agent/build && make all
```

The server also builds on demand when a client hits
`/api/rmm/download/:os/:arch` and no cached binary exists — this requires `go`
in `$PATH` on the server.

### Release build — reproducible + AV-friendly

```sh
# 1. Generate Windows resource file (one-time; re-run when bumping version)
go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
cd agent && go generate ./cmd/agent

# 2. Build all targets
cd agent/build && make all

# 3. Sign
#    macOS:   codesign --sign "Developer ID Application: Your Org" --options runtime --timestamp ...
#    Windows: signtool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com ...
```

Build flags (`-trimpath -buildvcs=false -ldflags='-s -w'`) are chosen for:
- **Reproducibility** — byte-identical builds from the same source. Required for
  the self-update SHA-256 check and makes code-signing pipelines deterministic.
- **No packers / obfuscators** — UPX etc. drastically raise Defender / Kaspersky
  / ClamAV false-positive rates. An unsigned-but-unpacked binary with a
  populated VERSIONINFO resource is materially quieter than a packed one.

## Security model

The agent operates on three layers of defense over the same HTTPS channel:

1. **Bearer token** — issued at enrollment, HMAC-SHA256 hashed server-side,
   constant-time compared on every request. Stored at rest AES-256-GCM
   encrypted with a key derived from the machine-id (Linux `/etc/machine-id`,
   macOS `IOPlatformUUID`, Windows registry `MachineGuid`).
2. **Per-agent HMAC command signing** — the agent generates its own 32-byte
   hex secret at enrollment and sends it to the server. Every dispatched
   command is signed with this secret and verified on the agent before
   execution. A replay cache prevents duplicate commands from running even
   within the signature validity window (10 min).
3. **TLS SPKI pinning (optional)** — `itcake-agent enroll --pin-tls` captures
   the leaf certificate's SubjectPublicKeyInfo SHA-256 and embeds it in
   config. Subsequent connections refuse any cert whose SPKI doesn't match,
   defeating CA-compromise and internal TLS-terminating middlebox attacks.

The `--insecure` flag on enroll skips TLS verification **only** for the
enrollment POST (bootstrap behind self-signed certs). It is NEVER persisted;
a subsequent `run` always verifies TLS. Combine with `--pin-tls` to capture
and then enforce the self-signed cert going forward.

## Commands

```
itcake-agent enroll --server URL --token TOKEN [--pin-tls] [--insecure] [--config PATH]
itcake-agent run [--config PATH]
itcake-agent service install
itcake-agent service uninstall
itcake-agent uninstall
itcake-agent version
```

## AV whitelisting for unsigned dev builds

Production releases should be code-signed — that eliminates most false
positives outright. If you need to run an unsigned debug build:

- **Microsoft Defender**: Add an exclusion for the install directory:
  `Add-MpPreference -ExclusionPath "C:\ProgramData\ITCake"`.
- **Kaspersky / ESET / Bitdefender**: Add the binary path to the trusted
  applications list. The vendor's SONAR/behavioral module flags Go
  binaries more often than the signature scanner.
- **ClamAV**: No action required for Linux server scans — ClamAV's
  false-positive rate on Go binaries is minimal.
- **macOS Gatekeeper**: Strip the quarantine bit with
  `xattr -rd com.apple.quarantine` and ad-hoc sign with `codesign --sign -`.
  The installer one-liner does this automatically.

For repeat false positives on a signed release, submit the binary to the
vendor's false-positive portal:
- Microsoft: https://www.microsoft.com/wdsi/filesubmission
- Kaspersky: https://opentip.kaspersky.com/
- Bitdefender: https://www.bitdefender.com/consumer/support/answer/1733/

## Files created

| OS      | Binary                                        | Config                                                                 | Service unit                                    |
|---------|-----------------------------------------------|------------------------------------------------------------------------|-------------------------------------------------|
| macOS   | `/usr/local/bin/itcake-agent`                 | `/Library/Application Support/ITCake/agent-config.json`                | `/Library/LaunchDaemons/com.itcake.agent.plist` |
| Linux   | `/usr/local/bin/itcake-agent`                 | `/etc/itcake-agent/config.json`                                        | `/etc/systemd/system/itcake-agent.service`      |
| Windows | `C:\ProgramData\ITCake\itcake-agent.exe`      | `C:\ProgramData\ITCake\agent-config.json`                              | SCM service `ITCakeAgent`                       |

All config files are created with 0600 (Unix) / inherited ACL (Windows) and
contain AES-256-GCM-encrypted bearer + HMAC secret fields.

## Uninstalling

```sh
sudo itcake-agent uninstall   # Unix
itcake-agent uninstall        # Windows (elevated prompt)
```

Removes the service definition, binary, config, logs, and any platform-specific
caches. Server-side the agent row must be deleted separately (Agents > ⋮ >
Delete) or it will retain historical metrics; a fresh enrollment for the
same hostname+os+arch will replace the old row automatically.
