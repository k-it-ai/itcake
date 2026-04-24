package config

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
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

// DefaultPath returns the platform-appropriate config location. Always
// writable only by the service's running user (0600 on Unix, ACL inherited
// from ProgramData on Windows).
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
	return nil
}

// --- Machine-bound encryption (AES-256-GCM) ---
//
// Key = SHA-256(machineID || "itcake-agent-v1"). machineID is read from a
// platform-specific stable source. Encryption prevents a copied config.json
// from being used to impersonate this agent on another machine.

const secretPrefix = "v1:"

func encryptSecret(plaintext string) (string, error) {
	key, err := machineKey()
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
		return "", err
	}
	ct := aead.Seal(nonce, nonce, []byte(plaintext), nil)
	return secretPrefix + base64.StdEncoding.EncodeToString(ct), nil
}

func decryptSecret(encoded string) (string, error) {
	if !strings.HasPrefix(encoded, secretPrefix) {
		return "", errors.New("unknown ciphertext format")
	}
	ct, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, secretPrefix))
	if err != nil {
		return "", fmt.Errorf("base64: %w", err)
	}
	key, err := machineKey()
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
	if len(ct) < ns {
		return "", errors.New("ciphertext truncated")
	}
	pt, err := aead.Open(nil, ct[:ns], ct[ns:], nil)
	if err != nil {
		return "", errors.New("authenticated decrypt failed")
	}
	return string(pt), nil
}

func machineKey() ([]byte, error) {
	id, err := readMachineID()
	if err != nil {
		return nil, err
	}
	h := sha256.Sum256(append(bytes.TrimSpace([]byte(id)), []byte("itcake-agent-v1")...))
	return h[:], nil
}

// readMachineID returns a stable, non-secret identifier for this host.
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
		// MachineGuid — survives reinstalls of most components; reset only on fresh OS install.
		out, err := exec.Command("reg", "query",
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
	// Fallback: hostname + OS. Weak — re-enrollment is cheap, so this is acceptable
	// when no stable ID is available (e.g. ephemeral containers).
	host, _ := os.Hostname()
	return host + "|" + runtime.GOOS, nil
}
