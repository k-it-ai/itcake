package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

type Config struct {
	ServerURL       string `json:"serverUrl"`
	Token           string `json:"token"`
	AgentID         string `json:"agentId"`
	CheckinInterval int    `json:"checkinInterval"` // seconds
	Insecure        bool   `json:"insecure"`        // skip TLS verify
}

func DefaultPath() string {
	if runtime.GOOS == "darwin" {
		return "/Library/Application Support/ITCake/agent-config.json"
	}
	return "/etc/itcake-agent/config.json"
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if cfg.CheckinInterval <= 0 {
		cfg.CheckinInterval = 60
	}
	return &cfg, nil
}

func (c *Config) Save(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}
