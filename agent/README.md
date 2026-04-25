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

# 3. Sign — see "Code-signing pipeline" below for ready-to-use recipes.
```

Build flags (`-trimpath -buildvcs=false -ldflags='-s -w'`) are chosen for:
- **Reproducibility** — byte-identical builds from the same source. Required for
  the self-update SHA-256 check and makes code-signing pipelines deterministic.
- **No packers / obfuscators** — UPX etc. drastically raise Defender / Kaspersky
  / ClamAV false-positive rates. An unsigned-but-unpacked binary with a
  populated VERSIONINFO resource is materially quieter than a packed one.

### Code-signing pipeline

Optional but strongly recommended for endpoints you don't control. A signed
release binary skips Defender SmartScreen prompts and macOS Gatekeeper warnings,
and materially reduces the false-positive rate on third-party AV.

The pipeline below is **not automated by this repo** — it intentionally lives in
your release workflow (CI / a one-shot operator script). Plug it in once and
the binary served by `/api/rmm/download/:os/:arch` becomes signed simply by
replacing the cached binary with the signed one.

#### Windows — Authenticode

Prereqs: an EV / OV code-signing certificate (DigiCert, SSL.com, Sectigo) on a
hardware token or in the Windows certificate store. Install the Windows 10 SDK
to get `signtool.exe`.

```powershell
# After building itcake-agent-windows-amd64.exe and itcake-agent-windows-arm64.exe
$timestamp = "http://timestamp.digicert.com"
$desc = "ITCake RMM Agent"

foreach ($f in "itcake-agent-windows-amd64.exe", "itcake-agent-windows-arm64.exe") {
    & "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22000.0\x64\signtool.exe" `
        sign /fd SHA256 /td SHA256 /tr $timestamp `
        /n "Your Company Inc"  `   # subject name on the cert
        /d $desc /du "https://itcake.example.com" $f
    & "...\signtool.exe" verify /pa /v $f
}
```

For a token in a CI runner, replace `/n` with `/sha1 <thumbprint>` and load the
key with `cng-key-store` or `tssconsole.exe` (vendor-specific). Hash the binary
**after** signing so the server's `binaryHash` reflects the signed bytes; the
agent's self-update SHA-256 check verifies the same.

#### macOS — Developer ID + notarization

Prereqs: an Apple Developer Program membership and a Developer ID Application
certificate in your login keychain. Generate an app-specific password for
`notarytool` and store it via `xcrun notarytool store-credentials`.

```sh
# After building itcake-agent-darwin-amd64 and itcake-agent-darwin-arm64
IDENTITY="Developer ID Application: Your Org Name (TEAMID)"

for f in itcake-agent-darwin-amd64 itcake-agent-darwin-arm64; do
    codesign --sign "$IDENTITY" --options runtime --timestamp \
             --entitlements agent/build/agent.entitlements "$f"
    codesign --verify --strict --verbose=2 "$f"
done

# Notarize as a zipped pair (notarytool only accepts .zip / .pkg / .dmg)
zip -j itcake-agent-darwin.zip itcake-agent-darwin-*
xcrun notarytool submit itcake-agent-darwin.zip \
      --keychain-profile "ITCAKE_NOTARY" \
      --wait
# Notarization stapler is N/A for raw binaries — Gatekeeper checks the cloud
# ticket on first run. Distribute the .zip or copy individual binaries.
```

`agent/build/agent.entitlements` (create as needed):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <!-- Hardened runtime: minimal entitlements. The agent runs ordinary
         shell commands; no JIT, no debugger attachment. -->
</dict></plist>
```

#### Linux — checksum + GPG signature

There's no platform-wide signing equivalent. The recommended flow is the same
one Debian / Arch use:

```sh
# Compute + sign the SHA-256 of each binary
for f in itcake-agent-linux-amd64 itcake-agent-linux-arm64; do
    sha256sum "$f" > "$f.sha256"
    gpg --armor --detach-sign "$f.sha256"
done
```

Operators verify with `gpg --verify itcake-agent-linux-amd64.sha256.asc` and
`sha256sum -c itcake-agent-linux-amd64.sha256` before installing. The
agent self-update path already verifies SHA-256 — adding GPG buys you a
human-verifiable initial-distribution step.

#### Wiring signed binaries into the server

Once signed, drop the binaries into `data/agent-binaries/` (replace the
unsigned cached file). Restart the server (or just touch the binary so its
mtime updates) — `getAgentBinaryHash()` recomputes on next access and the
new hash is what every checkin response advertises. Agents on the next
poll cycle will detect the hash mismatch, re-download, verify SHA-256,
smoke-test, and atomically swap.

#### What signing does NOT replace

- **TLS pinning** — code-signing protects the *binary*. SPKI pinning protects
  the *channel*. Both are independent layers; do both.
- **Per-agent HMAC** — even with a signed binary, the server only trusts a
  command if the per-agent HMAC matches. Compromise of one signed binary
  doesn't grant any privilege over other endpoints.

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

## Package managers — manual bootstrap

The agent does not install package managers. If a target machine doesn't
have `brew` / `winget` / `choco`, the corresponding manager simply doesn't
appear in the detected list, and commands targeting it return
`no suitable package manager found`.

To bootstrap a manager, dispatch an ordinary shell command from the UI
terminal (runs as the console user on Unix, LocalSystem on Windows):

```sh
# macOS — Homebrew (drops to console user via sudo -u automatically)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Linux — apt / dnf / pacman / apk ship with their distros; no action needed.

# Windows — winget (absent on pre-21H2 Win10 / Server 2019)
Add-AppxPackage "https://github.com/microsoft/winget-cli/releases/latest/download/Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle"

# Windows — Chocolatey (agent runs as LocalSystem; admin rights implicit)
Set-ExecutionPolicy Bypass -Scope Process -Force; `
  [System.Net.ServicePointManager]::SecurityProtocol = `
  [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; `
  iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
```

There is no one-click bootstrap button in the UI on purpose: piping a
vendor install script to shell as LocalSystem/root is exactly the class of
thing the rest of the security model avoids. Pasting the command explicitly
leaves a clear audit-log entry; a hidden button would not.

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
