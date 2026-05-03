package config

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Config is the on-disk agent configuration. Sensitive fields (Token,
// HMACSecret) are encrypted at rest with a machine-bound key — see
// encryptSecret/decryptSecret. This is defense-in-depth against casual
// exfiltration (e.g. whole-disk backups shipped off-box); it is NOT a
// hard security boundary against an attacker with local root.
type Config struct {
	ServerURL       string `json:"serverUrl"`
	Token           string `json:"-"` // decrypted in-memory
	TokenEnc        string `json:"tokenEnc,omitempty"`
	HMACSecret      string `json:"-"` // decrypted in-memory; per-agent shared secret for command HMAC
	HMACSecretEnc   string `json:"hmacSecretEnc,omitempty"`
	AgentID         string `json:"agentId"`
	CheckinInterval int    `json:"checkinInterval"` // seconds
	// TLSPinSHA256 is the hex-encoded SHA-256 of the server's leaf cert
	// SubjectPublicKeyInfo (SPKI). When set, the agent refuses to connect
	// unless the server presents the pinned key — this hardens against
	// CA compromise / internal MITM beyond standard TLS verification.
	TLSPinSHA256 string `json:"tlsPinSha256,omitempty"`
}

// getSystemRoot returns %SystemRoot% with a sane default. Both
// readMachineID and the Windows ACL helper need it; centralising
// keeps the fallback in one place.
func getSystemRoot() string {
	if v := os.Getenv("SystemRoot"); v != "" {
		return v
	}
	return `C:\Windows`
}

// DefaultPath returns the platform-appropriate config location. Always
// writable only by the service's running user (0600 on Unix, explicit
// ACL on Windows applied by lockdownPath).
func DefaultPath() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/ITCake/agent-config.json"
	case "windows":
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "ITCake", "agent-config.json")
	default:
		return "/etc/itcake-agent/config.json"
	}
}

// ValidateServerURL enforces https:// in production and rejects obviously
// malformed URLs. Plain http:// is allowed only when ITCAKE_ALLOW_HTTP=1
// (for local dev / internal network over TLS-terminating proxies).
func ValidateServerURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid server URL: %w", err)
	}
	if u.Host == "" {
		return errors.New("server URL is missing host")
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if os.Getenv("ITCAKE_ALLOW_HTTP") != "1" {
			return errors.New("http:// server URL rejected (set ITCAKE_ALLOW_HTTP=1 to override for dev)")
		}
		return nil
	default:
		return fmt.Errorf("unsupported scheme %q (expected https)", u.Scheme)
	}
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
	if cfg.TokenEnc != "" {
		tok, err := decryptSecret(cfg.TokenEnc)
		if err != nil {
			return nil, fmt.Errorf("decrypt bearer token (machine-id changed? reenroll): %w", err)
		}
		cfg.Token = tok
	}
	if cfg.HMACSecretEnc != "" {
		sec, err := decryptSecret(cfg.HMACSecretEnc)
		if err != nil {
			return nil, fmt.Errorf("decrypt hmac secret: %w", err)
		}
		cfg.HMACSecret = sec
	}
	if cfg.Token == "" {
		return nil, errors.New("config has no bearer token (reenroll)")
	}
	if err := ValidateServerURL(cfg.ServerURL); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) Save(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	if err := lockdownPath(dir); err != nil {
		return fmt.Errorf("lockdown config dir: %w", err)
	}
	out := *c // shallow copy for marshaling
	if c.Token != "" {
		enc, err := encryptSecret(c.Token)
		if err != nil {
			return fmt.Errorf("encrypt token: %w", err)
		}
		out.TokenEnc = enc
	}
	if c.HMACSecret != "" {
		enc, err := encryptSecret(c.HMACSecret)
		if err != nil {
			return fmt.Errorf("encrypt hmac secret: %w", err)
		}
		out.HMACSecretEnc = enc
	}
	data, err := json.MarshalIndent(&out, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	// Write to temp + rename for atomic replace.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(tmp, 0o600)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace config: %w", err)
	}
	if err := lockdownPath(path); err != nil {
		return fmt.Errorf("lockdown config file: %w", err)
	}
	return nil
}

// --- Machine-bound encryption (AES-256-GCM) ---
//
// v2 format: per-blob random 16-byte salt + HKDF-SHA256(machineID, salt,
// info="itcake-agent-v2", 32 bytes) → AES-GCM key. Replaces the older v1
// SHA-256(machineID || "itcake-agent-v1") which had two issues:
//
//   1. No salt — two hosts with identical machine-IDs (gold images, OS
//      clones, some container setups) shared a key. With a per-blob
//      random salt generated at fresh enrollment, each host's blobs
//      derive unique keys even when their machine-IDs collide.
//   2. Single-pass SHA-256 of concatenation is technically a working
//      KDF but not the modern recommendation. HKDF is the standard.
//
// A cloned config copied to a host with a different machine-ID still
// fails to decrypt: the salt comes along with the file, but the
// machineID input to HKDF differs, so the derived key differs.
//
// On-disk format: `v2:` + base64( salt[16] || nonce[12] || tag[16] || ciphertext ).
// v1 ciphertexts are REJECTED with a re-enrollment error — the repo is
// in development and we'd rather flush old blobs than carry forward two
// crypto formats indefinitely.

const (
	secretPrefixV2 = "v2:"
	secretPrefixV1 = "v1:" // rejected on read; kept here as a sentinel for the error path
	saltLen        = 16
	keyLen         = 32
)

func encryptSecret(plaintext string) (string, error) {
	id, err := readMachineID()
	if err != nil {
		return "", err
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("salt rand: %w", err)
	}
	key, err := deriveMachineKey(id, salt)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("nonce rand: %w", err)
	}
	// Layout: salt || nonce || ciphertext-with-tag-suffix.
	// `Seal` appends the auth tag to the ciphertext, so the resulting
	// blob is salt + nonce + (ciphertext + tag).
	out := make([]byte, 0, saltLen+aead.NonceSize()+len(plaintext)+aead.Overhead())
	out = append(out, salt...)
	out = append(out, nonce...)
	out = aead.Seal(out, nonce, []byte(plaintext), nil)
	return secretPrefixV2 + base64.StdEncoding.EncodeToString(out), nil
}

func decryptSecret(encoded string) (string, error) {
	if strings.HasPrefix(encoded, secretPrefixV1) {
		return "", errors.New("v1 ciphertext rejected; re-enroll the agent (config crypto format upgraded)")
	}
	if !strings.HasPrefix(encoded, secretPrefixV2) {
		return "", errors.New("unknown ciphertext format")
	}
	blob, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, secretPrefixV2))
	if err != nil {
		return "", fmt.Errorf("base64: %w", err)
	}
	if len(blob) < saltLen+12 /* GCM nonce */ +16 /* GCM tag */ {
		return "", errors.New("ciphertext truncated")
	}
	salt := blob[:saltLen]
	rest := blob[saltLen:]

	id, err := readMachineID()
	if err != nil {
		return "", err
	}
	key, err := deriveMachineKey(id, salt)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := aead.NonceSize()
	if len(rest) < ns {
		return "", errors.New("ciphertext truncated")
	}
	pt, err := aead.Open(nil, rest[:ns], rest[ns:], nil)
	if err != nil {
		return "", errors.New("authenticated decrypt failed")
	}
	return string(pt), nil
}

// deriveMachineKey returns a 32-byte AES key from the host machine-ID
// and a per-blob random salt via HKDF-SHA256.
func deriveMachineKey(id string, salt []byte) ([]byte, error) {
	trimmed := bytes.TrimSpace([]byte(id))
	return hkdf.Key(sha256.New, trimmed, salt, "itcake-agent-v2", keyLen)
}

// readMachineID returns a stable, non-secret identifier for this host.
//
// All shelled commands resolve absolute paths so a local user with PATH
// write access can't substitute their own `reg.exe` / `ioreg` to feed
// us an attacker-chosen machine-ID (which would let them recompute the
// HKDF master key and decrypt the agent's at-rest secrets).
func readMachineID() (string, error) {
	switch runtime.GOOS {
	case "linux":
		for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
			if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
				return string(b), nil
			}
		}
	case "darwin":
		// IOPlatformUUID — stable per Mac, not tied to user/volume.
		// Absolute path: /usr/sbin/ioreg is part of the macOS base
		// system and cannot be moved by a user without root.
		out, err := exec.Command("/usr/sbin/ioreg", "-d2", "-c", "IOPlatformExpertDevice").Output()
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				if strings.Contains(line, "IOPlatformUUID") {
					parts := strings.Split(line, "\"")
					if len(parts) >= 4 {
						return parts[3], nil
					}
				}
			}
		}
	case "windows":
		// only on fresh OS install. Absolute path defends against PATH
		systemRoot := getSystemRoot()
		regExe := filepath.Join(systemRoot, "System32", "reg.exe")
		out, err := exec.Command(regExe, "query",
			`HKLM\SOFTWARE\Microsoft\Cryptography`, "/v", "MachineGuid").Output()
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				if strings.Contains(line, "MachineGuid") {
					fields := strings.Fields(line)
					if len(fields) >= 3 {
						return fields[len(fields)-1], nil
					}
				}
			}
		}
	}
	// Fallback: hostname + OS. Weak — hostname is trivially guessable
	// by anyone who has the encrypted config, so the at-rest binding
	// is largely defeated when this path runs. We log it loudly so an
	// operator notices in logs / monitoring (the encrypted blobs WILL
	// still decrypt so the agent keeps working — just without the
	// machine-binding defense). Re-enrollment after fixing the
	// machine-id source restores full protection.
	host, _ := os.Hostname()
	fmt.Fprintf(os.Stderr,
		"[config] WARNING: machine-id source unavailable on %s — falling back to hostname (%s). "+
			"At-rest config encryption is significantly weakened; re-enroll once a stable machine-id source is available.\n",
		runtime.GOOS, host)
	return host + "|" + runtime.GOOS, nil
}
