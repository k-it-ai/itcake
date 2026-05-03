//go:build !windows

package main

import (
	"fmt"
	"os"

	"github.com/itcake/agent/internal/checkin"
	"github.com/itcake/agent/internal/config"
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
	fmt.Printf("ITCake Agent %s starting (server: %s, interval: %ds, pinned=%v)\n",
		version, cfg.ServerURL, cfg.CheckinInterval, cfg.TLSPinSHA256 != "")
	checkin.Run(cfg, configPath, version)
}
