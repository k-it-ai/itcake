package main

// The `go generate` command below produces `resource_windows.syso`
// (one per GOARCH) — a Windows PE resource file that the Go linker
// automatically embeds into the final .exe. This gives the binary:
//
//  1. VERSIONINFO — the Explorer "Properties" fields (CompanyName,
//     FileDescription, FileVersion, etc.). Windows Defender's
//     unsigned-binary heuristic is materially quieter when these
//     fields are populated.
//  2. Application manifest — declares requestedExecutionLevel=asInvoker,
//     long-path support, UTF-8 active code page. Avoids the
//     "requests admin but unsigned" flag and fixes UTF-8 I/O.
//
// Prerequisite:
//    go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
//
// Generate and build:
//    cd agent && go generate ./cmd/agent
//    GOOS=windows GOARCH=amd64 go build -o dist/itcake-agent.exe ./cmd/agent
//
// The two .syso files are *.gitignored* — they're always regenerated
// from versioninfo.json / agent.manifest which ARE committed.

// VERSIONINFO is architecture-independent; we generate once and copy to
// both per-arch filenames that Go's linker recognizes.
//go:generate goversioninfo -64 -o resource_windows_amd64.syso versioninfo.json
//go:generate cp resource_windows_amd64.syso resource_windows_arm64.syso
