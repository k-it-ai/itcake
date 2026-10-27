//go:build !windows

package commands

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

const killGrace = 5 * time.Second

// setProcessGroupAndCancel makes the child a process-group leader and
// kills the whole group on context cancel, so grandchildren forked by
// /bin/sh (apt-get, dpkg) don't outlive the timeout.
func setProcessGroupAndCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = killGrace
}

var consoleUserCached string

var consoleUsernameRE = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

func init() {
	if os.Getuid() == 0 && runtime.GOOS == "darwin" {
		out, err := exec.Command("/usr/bin/stat", "-f", "%Su", "/dev/console").Output()
		if err == nil {
			u := strings.TrimSpace(string(out))
			if u != "" && u != "root" && consoleUsernameRE.MatchString(u) {
				consoleUserCached = u
			}
		}
	}
}

// GetConsoleUser returns the logged-in non-root user, or "" when not
// running as root or detection failed.
func GetConsoleUser() string {
	return consoleUserCached
}

// Execute runs a shell command with a timeout. As root, drops to the
// console user (brew/npm refuse root); "sudo " prefix bypasses.
func Execute(command string, timeoutSec int) *Result {
	return executeInternal(command, timeoutSec, false)
}

// ExecuteAsRoot runs a command as root even when Execute would drop privileges.
func ExecuteAsRoot(command string, timeoutSec int) *Result {
	return executeInternal(command, timeoutSec, true)
}

// ExecuteArgvAsRoot runs a binary with explicit argv as root, bypassing /bin/sh.
// Use for any command whose args come from untrusted upstream input.
func ExecuteArgvAsRoot(name string, args []string, timeoutSec int) *Result {
	return executeArgvInternal(name, args, timeoutSec, true)
}

// ExecuteArgv runs a binary with explicit argv, dropping to the console user
// when root. Use whenever args contain operator/server-controlled fields.
func ExecuteArgv(name string, args []string, timeoutSec int) *Result {
	return executeArgvInternal(name, args, timeoutSec, false)
}

func executeArgvInternal(name string, args []string, timeoutSec int, asRoot bool) *Result {
	startedAt := time.Now().UTC().Format(time.RFC3339)

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	user := GetConsoleUser()
	var cmd *exec.Cmd
	if !asRoot && user != "" && os.Getuid() == 0 {
		sudoArgs := append([]string{"-u", user, "-H", "--non-interactive", name}, args...)
		cmd = exec.CommandContext(ctx, syspath.Sudo(), sudoArgs...)
	} else {
		cmd = exec.CommandContext(ctx, name, args...)
	}
	cmd.Env = extendedEnv(asRoot)
	setProcessGroupAndCancel(cmd)

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
		cmd = exec.CommandContext(ctx, syspath.Sudo(), "-u", user, "-H", "--non-interactive", "/bin/sh", "-c", command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-c", command)
	}
	cmd.Env = extendedEnv(asRoot)
	setProcessGroupAndCancel(cmd)

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

// ExtendedPath returns PATH with common tool directories prepended so
// brew/npm/pip are found under LaunchDaemons / systemd minimal PATH.
func ExtendedPath() string {
	extra := []string{
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
		"/home/linuxbrew/.linuxbrew/bin",
		"/snap/bin",
	}
	if home := os.Getenv("HOME"); home != "" {
		extra = append(extra,
			home+"/.local/bin",
			home+"/.nvm/current/bin",
			home+"/go/bin",
		)
	}
	current := os.Getenv("PATH")
	if runtime.GOOS == "darwin" && current == "" {
		current = "/usr/bin:/bin:/usr/sbin:/sbin"
	}
	return strings.Join(extra, ":") + ":" + current
}

// dangerousEnvVars are stripped before spawning children. They let a
// caller inject code into an otherwise-trusted binary (dyld/ld.so hooks,
// interpreter startup files).
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

// safeRootPath contains only system-owned directories. Privileged
// commands must not resolve binaries from a user-writable home.
func safeRootPath() string {
	dirs := []string{"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"}
	if runtime.GOOS == "darwin" {
		dirs = append([]string{"/opt/homebrew/bin", "/opt/homebrew/sbin"}, dirs...)
	}
	return strings.Join(dirs, ":")
}

func extendedEnv(asRoot bool) []string {
	env := sanitizedEnviron()
	extPath := ExtendedPath()
	if asRoot {
		extPath = safeRootPath()
	}
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
	// macOS root home is /var/root; Linux is /root. Hard-coding /var/root on
	// Linux breaks pip --user / npm config because that path doesn't exist.
	if !hasHome {
		if runtime.GOOS == "darwin" {
			env = append(env, "HOME=/var/root")
		} else {
			env = append(env, "HOME=/root")
		}
	}
	if !hasUser {
		env = append(env, "USER=root")
	}
	return env
}
