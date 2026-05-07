//go:build windows

package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/debug"

	"github.com/itcake/agent/internal/checkin"
	"github.com/itcake/agent/internal/config"
	"github.com/itcake/agent/internal/services"
	"github.com/itcake/agent/internal/state"
)

// cmdRun on Windows detects whether the process was launched by the
// Service Control Manager. When it was, we register a proper SCM
// handler (so the service starts/stops cleanly); otherwise we run in
// the foreground like Unix does.
func cmdRun() {
	configPath := config.DefaultPath()
	for i := 2; i < len(os.Args); i++ {
		if os.Args[i] == "--config" && i+1 < len(os.Args) {
			i++
			configPath = os.Args[i]
		}
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error loading config: %v\n", err)
		fmt.Fprintln(os.Stderr, "Run 'itcake-agent enroll' first.")
		os.Exit(1)
	}
	if err := config.EnsureLockdown(configPath); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not lock down config ACL: %v\n", err)
	}

	statePath := state.PathInDir(filepath.Dir(configPath))
	if err := state.WriteRunning(statePath, version); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not write state file: %v\n", err)
	}

	isSvc, err := svc.IsWindowsService()
	if err != nil {
		fmt.Fprintf(os.Stderr, "svc.IsWindowsService: %v\n", err)
		os.Exit(1)
	}
	if !isSvc {
		// Foreground (e.g. `itcake-agent run` from a console). Trap
		// Ctrl-C so we still update the state file before exit.
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			<-sig
			_ = state.WriteStopping(statePath)
			os.Exit(0)
		}()
		fmt.Printf("ITCake Agent %s starting (foreground; server=%s, pinned=%v)\n",
			version, cfg.ServerURL, cfg.TLSPinSHA256 != "")
		checkin.Run(cfg, configPath, version)
		return
	}
	// Under SCM — hand off to the service dispatcher.
	_ = debug.Run // silence unused-import warning in minimal builds
	if err := svc.Run(services.ServiceName, &windowsService{cfg: cfg, configPath: configPath, statePath: statePath}); err != nil {
		fmt.Fprintf(os.Stderr, "svc.Run failed: %v\n", err)
		os.Exit(1)
	}
}

type windowsService struct {
	cfg        *config.Config
	configPath string
	statePath  string
}

// Execute implements svc.Handler. SCM calls this on service start; we
// must:
//   1. Report StartPending quickly (< 30s or SCM kills us).
//   2. Launch the blocking check-in loop in a goroutine.
//   3. Enter a control-message loop that ACKs stop requests promptly.
func (ws *windowsService) Execute(args []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (ssec bool, errno uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	s <- svc.Status{State: svc.StartPending}

	// Start the agent loop. The loop itself doesn't return; on a stop
	// request we just exit the process and let the SCM restart-on-stop
	// behavior be driven by recovery actions (we never return 0/success
	// from a forced stop — the user asked us to halt).
	done := make(chan struct{})
	go func() {
		defer close(done)
		checkin.Run(ws.cfg, ws.configPath, version)
	}()

	s <- svc.Status{State: svc.Running, Accepts: accepted}

loop:
	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				_ = state.WriteStopping(ws.statePath)
				break loop
			default:
				// Ignore unknown control codes — SCM sends vendor-specific
				// ones that we have no use for.
			}
		case <-done:
			// checkin.Run returned (it doesn't, but defensively handle it).
			break loop
		}
	}

	s <- svc.Status{State: svc.StopPending}
	// Process exit is the cleanest way to halt in-flight HTTP calls.
	// SCM sees State==Stopped from the exit-code return below.
	return false, 0
}
