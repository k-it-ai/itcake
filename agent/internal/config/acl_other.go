//go:build !windows

package config

func lockdownPath(_ string) error { return nil }
