//go:build windows

package commands

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// GetConsoleUser returns empty on Windows — we don't drop privileges
// the same way as Unix. Package managers that matter on Windows
// (winget, choco) run fine under LocalSystem, and scoop is explicitly
// disabled in service context.
func GetConsoleUser() string { return "" }

// Execute runs a command on Windows. Rules:
//   - Default interpreter: cmd.exe /c  — the fastest-path, lowest-AV-noise
//     option. Already how winget/choco/MSIs expect to be invoked.
//   - Explicit PowerShell: commands that start with "powershell" are run
//     as-is (still through cmd.exe /c) so they keep their own flags.
//   - NEVER: we do not download and run external scripts, do not use
//     Invoke-Expression, do not touch AMSI bypass flags. This keeps
//     Defender/Kaspersky/ClamAV false-positive rate low.
func Execute(command string, timeoutSec int) *Result {
	return executeInternal(command, timeoutSec)
}

// ExecuteAsRoot is a no-op difference on Windows; the agent already
// runs as LocalSystem when installed as a service. Kept for API
// compatibility with the Unix executor.
func ExecuteAsRoot(command string, timeoutSec int) *Result {
	return executeInternal(command, timeoutSec)
}

// ExecuteArgvAsRoot runs an executable with explicit argv (no cmd.exe
// interpretation) — use this for any command whose arguments come from
// untrusted upstream input. Avoids cmd.exe metacharacter expansion
// (`&`, `|`, `^`, `%VAR%`).
func ExecuteArgvAsRoot(name string, args []string, timeoutSec int) *Result {
	startedAt := time.Now().UTC().Format(time.RFC3339)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000 /* CREATE_NO_WINDOW */}
	cmd.Env = extendedEnv()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout, limit: MaxStdoutSize}
	cmd.Stderr = &limitedWriter{buf: &stderr, limit: MaxStderrSize}

	err := cmd.Run()
	completedAt := time.Now().UTC().Format(time.RFC3339)

	result := &Result{
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Stdout:      stdout.String(),
		Stderr:      stderr.String(),
	}
	if err != nil {
		result.Status = "failed"
		if exitErr, ok := err.(*exec.ExitError); ok {
			code := exitErr.ExitCode()
			result.ExitCode = &code
		} else if ctx.Err() == context.DeadlineExceeded {
			result.Stderr += "\r\n[command timed out]"
			code := -1
			result.ExitCode = &code
		}
	} else {
		result.Status = "completed"
		code := 0
		result.ExitCode = &code
	}
	return result
}

func executeInternal(command string, timeoutSec int) *Result {
	startedAt := time.Now().UTC().Format(time.RFC3339)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", command)
	// /d: skip AutoRun, /s: preserve quoting, /c: execute + exit.
	// SysProcAttr: don't pop a console window on GUI sessions.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000 /* CREATE_NO_WINDOW */}
	cmd.Env = extendedEnv()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout, limit: MaxStdoutSize}
	cmd.Stderr = &limitedWriter{buf: &stderr, limit: MaxStderrSize}

	err := cmd.Run()
	completedAt := time.Now().UTC().Format(time.RFC3339)

	result := &Result{
		StartedAt:   startedAt,
		CompletedAt: &completedAt,
		Stdout:      stdout.String(),
		Stderr:      stderr.String(),
	}
	if err != nil {
		result.Status = "failed"
		if exitErr, ok := err.(*exec.ExitError); ok {
			code := exitErr.ExitCode()
			result.ExitCode = &code
		} else if ctx.Err() == context.DeadlineExceeded {
			result.Stderr += "\r\n[command timed out]"
			code := -1
			result.ExitCode = &code
		}
	} else {
		result.Status = "completed"
		code := 0
		result.ExitCode = &code
	}
	return result
}

// ExtendedPath on Windows includes winget's and choco's default install
// locations so the agent finds them even when running as LocalSystem
// with a trimmed PATH.
func ExtendedPath() string {
	extra := []string{
		`C:\ProgramData\chocolatey\bin`,
		`C:\Program Files\WindowsApps`,
	}
	// User profile paths only make sense when HOMEDRIVE/USERPROFILE is set.
	if userProfile := os.Getenv("USERPROFILE"); userProfile != "" {
		extra = append(extra,
			userProfile+`\AppData\Local\Microsoft\WindowsApps`, // winget shim
			userProfile+`\scoop\shims`,
		)
	}
	current := os.Getenv("PATH")
	return strings.Join(extra, ";") + ";" + current
}

func extendedEnv() []string {
	env := os.Environ()
	extPath := ExtendedPath()
	hasPath := false
	for i, e := range env {
		if strings.HasPrefix(strings.ToUpper(e), "PATH=") {
			env[i] = "PATH=" + extPath
			hasPath = true
		}
	}
	if !hasPath {
		env = append(env, "PATH="+extPath)
	}
	return env
}
