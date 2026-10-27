//go:build windows

package commands

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

const killGrace = 5 * time.Second

// setTreeKillOnCancel kills the whole process tree on cancel via
// `taskkill /T /F`, so winget/msiexec/PowerShell grandchildren don't
// outlive the timeout.
func setTreeKillOnCancel(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		pid := cmd.Process.Pid
		killCmd := exec.Command(syspath.Taskkill(), "/T", "/F", "/PID", fmt.Sprintf("%d", pid))
		killCmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
		_ = killCmd.Run()
		return cmd.Process.Kill()
	}
	cmd.WaitDelay = killGrace
}

// GetConsoleUser returns "" on Windows; no privilege drop needed under LocalSystem.
func GetConsoleUser() string { return "" }

// Execute runs a command via cmd.exe /c.
func Execute(command string, timeoutSec int) *Result {
	return executeInternal(command, timeoutSec)
}

// ExecuteAsRoot is identical to Execute on Windows (agent already LocalSystem).
func ExecuteAsRoot(command string, timeoutSec int) *Result {
	return executeInternal(command, timeoutSec)
}

// ExecuteArgv runs an executable with explicit argv (no cmd.exe interpretation).
func ExecuteArgv(name string, args []string, timeoutSec int) *Result {
	return ExecuteArgvAsRoot(name, args, timeoutSec)
}

// ExecuteArgvAsRoot runs an executable with explicit argv, bypassing cmd.exe
// metacharacter expansion. Use for any command whose args come from upstream input.
func ExecuteArgvAsRoot(name string, args []string, timeoutSec int) *Result {
	startedAt := time.Now().UTC().Format(time.RFC3339)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000 /* CREATE_NO_WINDOW */}
	cmd.Env = extendedEnv()
	setTreeKillOnCancel(cmd)

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

	cmd := exec.CommandContext(ctx, syspath.CmdExe(), "/d", "/s", "/c", command)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000 /* CREATE_NO_WINDOW */}
	cmd.Env = extendedEnv()
	setTreeKillOnCancel(cmd)

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

// ExtendedPath includes winget/choco install dirs so they resolve under LocalSystem.
func ExtendedPath() string {
	extra := []string{
		`C:\ProgramData\chocolatey\bin`,
		`C:\Program Files\WindowsApps`,
	}
	if userProfile := os.Getenv("USERPROFILE"); userProfile != "" {
		extra = append(extra,
			userProfile+`\AppData\Local\Microsoft\WindowsApps`,
			userProfile+`\scoop\shims`,
		)
	}
	current := os.Getenv("PATH")
	return strings.Join(extra, ";") + ";" + current
}

// dangerousEnvVars are stripped before spawning children so inherited
// environment cannot inject code into a trusted binary.
var dangerousEnvVars = map[string]bool{
	"LD_PRELOAD":                 true,
	"LD_LIBRARY_PATH":            true,
	"LD_AUDIT":                   true,
	"DYLD_INSERT_LIBRARIES":      true,
	"DYLD_LIBRARY_PATH":          true,
	"DYLD_FRAMEWORK_PATH":        true,
	"DYLD_FALLBACK_LIBRARY_PATH": true,
	"BASH_ENV":                   true,
	"ENV":                        true,
	"PYTHONPATH":                 true,
	"PERL5LIB":                   true,
	"RUBYLIB":                    true,
	"NODE_OPTIONS":               true,
}

func sanitizedEnviron() []string {
	src := os.Environ()
	out := make([]string, 0, len(src))
	for _, e := range src {
		name := e
		if i := strings.IndexByte(e, '='); i >= 0 {
			name = e[:i]
		}
		if dangerousEnvVars[strings.ToUpper(name)] {
			continue
		}
		out = append(out, e)
	}
	return out
}

func extendedEnv() []string {
	env := sanitizedEnviron()
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
