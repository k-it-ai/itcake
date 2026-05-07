//go:build !windows

package commands

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

// consoleUserCached is set once at process start (init) so concurrent
// command goroutines never race on lazy detection. Linux deliberately
// returns "" — see packages/userctx.go for the rationale (service identity
// is the only safe default).
var consoleUserCached string

func init() {
	if os.Getuid() == 0 && runtime.GOOS == "darwin" {
		out, err := exec.Command("/usr/bin/stat", "-f", "%Su", "/dev/console").Output()
		if err == nil {
			u := strings.TrimSpace(string(out))
			if u != "" && u != "root" {
				consoleUserCached = u
			}
		}
	}
}

// GetConsoleUser returns the logged-in non-root user, or "" when the
// agent is not running as root or detection failed at startup.
func GetConsoleUser() string {
	return consoleUserCached
}

// Execute runs a shell command with a timeout and captures output.
// When running as root, shell commands execute as the console user by default
// (since tools like brew, npm refuse root). Commands prefixed with "sudo " bypass this.
func Execute(command string, timeoutSec int) *Result {
	return executeInternal(command, timeoutSec, false)
}

// ExecuteAsRoot runs a command as root even when the executor normally drops privileges.
// Used for operations that need root (e.g. removing /Applications/*.app).
func ExecuteAsRoot(command string, timeoutSec int) *Result {
	return executeInternal(command, timeoutSec, true)
}

// ExecuteArgvAsRoot runs a binary with explicit argv as root, bypassing
// /bin/sh entirely. Use this for any command whose arguments come from
// untrusted upstream input (e.g. reboot message text). Avoids the entire
// class of shell-injection bugs that arise when callers build a shell
// string with operator/server-controlled fields.
func ExecuteArgvAsRoot(name string, args []string, timeoutSec int) *Result {
	startedAt := time.Now().UTC().Format(time.RFC3339)

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
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
			result.Stderr += "\n[command timed out]"
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

func executeInternal(command string, timeoutSec int, asRoot bool) *Result {
	startedAt := time.Now().UTC().Format(time.RFC3339)

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	user := GetConsoleUser()
	var cmd *exec.Cmd
	if !asRoot && user != "" && os.Getuid() == 0 && !strings.HasPrefix(command, "sudo ") {
		// Run as console user via sudo — pass command as a single argument to sh
		// Using arg list (not string interpolation) avoids quoting/escaping issues
		cmd = exec.CommandContext(ctx, syspath.Sudo(), "-u", user, "-H", "--non-interactive", "/bin/sh", "-c", command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-c", command)
	}
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
			result.Stderr += "\n[command timed out]"
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

// ExtendedPath returns PATH with common tool directories prepended.
// LaunchDaemons and systemd services have minimal PATH; this ensures
// brew, npm, pip, etc. are found.
func ExtendedPath() string {
	extra := []string{
		"/opt/homebrew/bin", // macOS ARM brew
		"/opt/homebrew/sbin",
		"/usr/local/bin", // macOS Intel brew, manual installs
		"/usr/local/sbin",
		"/home/linuxbrew/.linuxbrew/bin", // Linuxbrew
		"/snap/bin",                      // snap packages
	}
	if home := os.Getenv("HOME"); home != "" {
		extra = append(extra,
			home+"/.local/bin",       // pip --user
			home+"/.nvm/current/bin", // nvm node
			home+"/go/bin",           // go install
		)
	}
	current := os.Getenv("PATH")
	if runtime.GOOS == "darwin" && current == "" {
		current = "/usr/bin:/bin:/usr/sbin:/sbin"
	}
	return strings.Join(extra, ":") + ":" + current
}

func extendedEnv() []string {
	env := os.Environ()
	extPath := ExtendedPath()
	hasPath, hasHome, hasUser := false, false, false
	for i, e := range env {
		if strings.HasPrefix(e, "PATH=") {
			env[i] = "PATH=" + extPath
			hasPath = true
		} else if strings.HasPrefix(e, "HOME=") {
			hasHome = true
		} else if strings.HasPrefix(e, "USER=") {
			hasUser = true
		}
	}
	if !hasPath {
		env = append(env, "PATH="+extPath)
	}
	// LaunchDaemons run as root without HOME/USER — brew and npm require these
	if !hasHome {
		env = append(env, "HOME=/var/root")
	}
	if !hasUser {
		env = append(env, "USER=root")
	}
	return env
}
