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

	"github.com/itcake/agent/internal/atomicfs"
)

// Config is the on-disk agent configuration. Sensitive fields are encrypted
// at rest with a machine-bound key (encryptSecret/decryptSecret) —
// defense-in-depth, not a boundary against local root.
type Config struct {
	ServerURL       string `json:"serverUrl"`
	Token           string `json:"-"`
	TokenEnc        string `json:"tokenEnc,omitempty"`
	HMACSecret      string `json:"-"`
	HMACSecretEnc   string `json:"hmacSecretEnc,omitempty"`
	AgentID         string `json:"agentId"`
	CheckinInterval int    `json:"checkinInterval"`
	// TLSPinSHA256 is the hex SHA-256 of the server leaf cert SPKI. Defends
	// against CA compromise / internal MITM beyond TLS chain validation.
	TLSPinSHA256 string `json:"tlsPinSha256,omitempty"`

	MaxConcurrentCommands int `json:"maxConcurrentCommands,omitempty"`
	CommandQueueSize      int `json:"commandQueueSize,omitempty"`

	// ManifestPubKeys: base64 raw 32-byte Ed25519 pubkeys accepted for
	// self-update manifest signatures. Persisted with AAD `manifestPubKeys`
	// so a local tamper can't swap them without breaking the GCM tag.
	ManifestPubKeys    []string `json:"-"`
	ManifestPubKeysEnc string   `json:"manifestPubKeysEnc,omitempty"`
}

const (
	DefaultMaxConcurrentCommands = 4
	MinMaxConcurrentCommands     = 1
	MaxMaxConcurrentCommands     = 32
	DefaultCommandQueueSize      = 16
	MinCommandQueueSize          = 1
	MaxCommandQueueSize          = 256
)

func (c *Config) applyConcurrencyDefaults() {
	if c.MaxConcurrentCommands < MinMaxConcurrentCommands || c.MaxConcurrentCommands > MaxMaxConcurrentCommands {
		c.MaxConcurrentCommands = DefaultMaxConcurrentCommands
	}
	if c.CommandQueueSize < MinCommandQueueSize || c.CommandQueueSize > MaxCommandQueueSize {
		c.CommandQueueSize = DefaultCommandQueueSize
	}
}

func getSystemRoot() string {
	if v := os.Getenv("SystemRoot"); v != "" {
		return v
	}
	return `C:\Windows`
}

// DefaultPath returns the platform-appropriate config location.
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

// ValidateServerURL enforces https; http allowed only when ITCAKE_ALLOW_HTTP=1.
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

func EnsureLockdown(path string) error {
	if err := lockdownPath(filepath.Dir(path)); err != nil {
		return err
	}
	return lockdownPath(path)
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
	cfg.applyConcurrencyDefaults()
	if cfg.TokenEnc != "" {
		tok, err := decryptSecret(cfg.TokenEnc, "tokenEnc")
		if err != nil {
			return nil, fmt.Errorf("decrypt bearer token (machine-id changed? reenroll): %w", err)
		}
		cfg.Token = tok
	}
	if cfg.HMACSecretEnc != "" {
		sec, err := decryptSecret(cfg.HMACSecretEnc, "hmacSecretEnc")
		if err != nil {
			return nil, fmt.Errorf("decrypt hmac secret: %w", err)
		}
		cfg.HMACSecret = sec
	}
	if cfg.ManifestPubKeysEnc != "" {
		raw, err := decryptSecret(cfg.ManifestPubKeysEnc, "manifestPubKeys")
		if err != nil {
			// Fail-open: update verification falls back to env-var trust set.
			fmt.Fprintf(os.Stderr, "[config] decrypt manifest pubkeys failed (%v); update signature checking falls back to env / advisory-only\n", err)
		} else {
			var keys []string
			if err := json.Unmarshal([]byte(raw), &keys); err != nil {
				fmt.Fprintf(os.Stderr, "[config] manifest pubkeys JSON parse failed (%v); ignoring stored keys\n", err)
			} else {
				cfg.ManifestPubKeys = keys
			}
		}
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
	out := *c
	if c.Token != "" {
		enc, err := encryptSecret(c.Token, "tokenEnc")
		if err != nil {
			return fmt.Errorf("encrypt token: %w", err)
		}
		out.TokenEnc = enc
	}
	if c.HMACSecret != "" {
		enc, err := encryptSecret(c.HMACSecret, "hmacSecretEnc")
		if err != nil {
			return fmt.Errorf("encrypt hmac secret: %w", err)
		}
		out.HMACSecretEnc = enc
	}
	if len(c.ManifestPubKeys) > 0 {
		payload, err := json.Marshal(c.ManifestPubKeys)
		if err != nil {
			return fmt.Errorf("marshal manifest pubkeys: %w", err)
		}
		enc, err := encryptSecret(string(payload), "manifestPubKeys")
		if err != nil {
			return fmt.Errorf("encrypt manifest pubkeys: %w", err)
		}
		out.ManifestPubKeysEnc = enc
	}
	data, err := json.MarshalIndent(&out, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	// atomicfs fsyncs tmp + parent dir and chmods 0o600 post-rename so a
	// power loss can't lose the bearer + HMAC + manifest pubkeys.
	if err := atomicfs.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if err := lockdownPath(path); err != nil {
		return fmt.Errorf("lockdown config file: %w", err)
	}
	return nil
}

// Machine-bound encryption (AES-256-GCM):
//   v1: rejected (no salt, weak KDF; re-enroll)
//   v2: base64(salt[16] || nonce[12] || ciphertext || tag[16]) — no AAD (legacy)
//   v3: same layout, AAD = field name — prevents config-file write attacker
//       from swapping tokenEnc and hmacSecretEnc ciphertexts.

const (
	secretPrefixV3 = "v3:"
	secretPrefixV2 = "v2:"
	secretPrefixV1 = "v1:"
	saltLen        = 16
	keyLen         = 32
)

func encryptSecret(plaintext string, aad string) (string, error) {
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
	// Do not size the buffer from len(plaintext): the addition could overflow
	// for an adversarially large input. Let append/Seal grow it instead.
	out := make([]byte, 0, saltLen+aead.NonceSize())
	out = append(out, salt...)
	out = append(out, nonce...)
	out = aead.Seal(out, nonce, []byte(plaintext), []byte(aad))
	return secretPrefixV3 + base64.StdEncoding.EncodeToString(out), nil
}

func decryptSecret(encoded string, aad string) (string, error) {
	if strings.HasPrefix(encoded, secretPrefixV1) {
		return "", errors.New("v1 ciphertext rejected; re-enroll the agent (config crypto format upgraded)")
	}
	var prefix string
	var useAad []byte
	switch {
	case strings.HasPrefix(encoded, secretPrefixV3):
		prefix = secretPrefixV3
		useAad = []byte(aad)
	case strings.HasPrefix(encoded, secretPrefixV2):
		// v2 has no AAD binding — accepted for legacy fleet; AAD-swap
		// attacks are theoretically possible until re-enrollment.
		prefix = secretPrefixV2
		useAad = nil
	default:
		return "", errors.New("unknown ciphertext format")
	}
	blob, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, prefix))
	if err != nil {
		return "", fmt.Errorf("base64: %w", err)
	}
	if len(blob) < saltLen+12+16 {
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
	pt, err := aead.Open(nil, rest[:ns], rest[ns:], useAad)
	if err != nil {
		return "", errors.New("authenticated decrypt failed")
	}
	return string(pt), nil
}

func deriveMachineKey(id string, salt []byte) ([]byte, error) {
	trimmed := bytes.TrimSpace([]byte(id))
	return hkdf.Key(sha256.New, trimmed, salt, "itcake-agent-v2", keyLen)
}

// readMachineID returns a stable host identifier. Absolute shell paths
// defend against PATH-hijack — a substituted reg.exe/ioreg could feed us
// an attacker-chosen ID and let them re-derive the HKDF master key.
func readMachineID() (string, error) {
	switch runtime.GOOS {
	case "linux":
		for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
			if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
				return string(b), nil
			}
		}
	case "darwin":
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
	// Hostname fallback: at-rest binding is largely defeated (hostname is
	// guessable). Loud log so the operator notices; agent keeps working.
	host, _ := os.Hostname()
	fmt.Fprintf(os.Stderr,
		"[config] WARNING: machine-id source unavailable on %s — falling back to hostname (%s). "+
			"At-rest config encryption is significantly weakened; re-enroll once a stable machine-id source is available.\n",
		runtime.GOOS, host)
	return host + "|" + runtime.GOOS, nil
}
