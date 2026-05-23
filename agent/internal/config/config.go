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
	// Concurrency caps for the command-execution worker pool. Zero values
	// mean "use defaults" (4 workers, queue 16); out-of-range values are
	// clamped on Load. See workerpool.New.
	MaxConcurrentCommands int `json:"maxConcurrentCommands,omitempty"`
	CommandQueueSize      int `json:"commandQueueSize,omitempty"`

	// ManifestPubKeys is a list of base64-encoded raw 32-byte Ed25519
	// public keys the agent will accept for self-update manifest
	// signatures. Captured at enrollment from the server's response and
	// persisted encrypted (AAD `manifestPubKeys` binds the blob to the
	// machine-id-derived key, so a local non-root tamper can't swap pubkeys
	// without breaking the GCM tag). Merged with env-var pubkeys
	// (ITCAKE_UPDATE_MANIFEST_PUBKEYS) at Run() startup.
	ManifestPubKeys    []string `json:"-"` // decrypted in-memory
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

// applyConcurrencyDefaults clamps the worker-pool fields into legal
// ranges. Zero or out-of-bounds values silently fall back to the
// documented defaults so a hand-edited config can't crash the agent.
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
			// Fail-open here: a missing/broken pubkey blob means update
			// verification falls back to the env-var trust set (or
			// advisory-only if nothing is configured). Log loudly so the
			// operator notices.
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
	out := *c // shallow copy for marshaling
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
	// fsync the tmp file + the parent dir so a power loss between
	// rename and the next page-cache flush doesn't lose the agent's
	// encrypted bearer + per-row HMAC + manifest pubkeys. atomicfs
	// also chmods 0o600 explicitly post-rename to defeat umask.
	if err := atomicfs.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
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
// On-disk formats:
//   v2: `v2:` + base64( salt[16] || nonce[12] || tag[16] || ciphertext )       (no AAD — legacy)
//   v3: `v3:` + base64( salt[16] || nonce[12] || tag[16] || ciphertext )       (AAD = field name)
//
// v3 binds each ciphertext to its field (`tokenEnc` vs `hmacSecretEnc`) via
// the GCM AAD so an attacker with write access to the config file can't
// swap the two ciphertexts. v2 reads still succeed for backward compat
// during a fleet upgrade — agents will write v3 on the next enrollment.
// v1 ciphertexts are REJECTED with a re-enrollment error.

const (
	secretPrefixV3 = "v3:"
	secretPrefixV2 = "v2:"
	secretPrefixV1 = "v1:" // rejected on read; kept here as a sentinel for the error path
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
	// v3 layout: salt || nonce || ciphertext-with-tag-suffix, AAD = aad string.
	// AAD binds the ciphertext to its field name (`tokenEnc`/`hmacSecretEnc`)
	// so a file-write attacker can't swap blobs between fields.
	out := make([]byte, 0, saltLen+aead.NonceSize()+len(plaintext)+aead.Overhead())
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
		// v2 has no AAD binding — accept for legacy fleet but log a
		// re-enroll hint via the caller's audit path. AAD-swap attacks
		// are theoretically possible against v2 blobs.
		prefix = secretPrefixV2
		useAad = nil
	default:
		return "", errors.New("unknown ciphertext format")
	}
	blob, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, prefix))
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
	pt, err := aead.Open(nil, rest[:ns], rest[ns:], useAad)
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
