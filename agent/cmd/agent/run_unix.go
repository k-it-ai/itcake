//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/itcake/agent/internal/checkin"
	"github.com/itcake/agent/internal/config"
	"github.com/itcake/agent/internal/state"
)

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

	// Trap SIGINT/SIGTERM so we can flip the state file to "stopping"
	// before exiting. systemd sends SIGTERM on `systemctl stop`; bare
	// kill from an operator likewise hits one of these. Handling them
	// here keeps the supervisor's signal sequence intact (the goroutine
	// exits after one signal so a second still terminates the process
	// promptly via the default handler).
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-sig
		_ = state.WriteStopping(statePath)
		fmt.Fprintf(os.Stderr, "received %s; exiting\n", s)
		os.Exit(0)
	}()

	fmt.Printf("ITCake Agent %s starting (server: %s, interval: %ds, pinned=%v)\n",
		version, cfg.ServerURL, cfg.CheckinInterval, cfg.TLSPinSHA256 != "")
	checkin.Run(cfg, configPath, version)
}
