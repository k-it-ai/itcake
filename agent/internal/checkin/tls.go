package checkin

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// buildHTTPClient returns a hardened http.Client.
//
//   - Always verifies TLS (cannot be disabled at runtime after enroll).
//   - MinVersion TLS 1.2.
//   - Optional SPKI pinning via pinSHA256 (hex SHA-256 of the leaf cert's
//     SubjectPublicKeyInfo). When set, the connection is aborted if no
//     presented cert's SPKI matches — defends against CA compromise and
//     internal TLS-terminating middleboxes injected post-enrollment.
//   - DialContext + TLS handshake timeouts so a slow peer can't wedge the
//     agent.
func buildHTTPClient(pinSHA256 string) *http.Client {
	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
	}
	if pinSHA256 != "" {
		expect := strings.ToLower(strings.TrimSpace(pinSHA256))
		tlsCfg.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			// Match ONLY the leaf (rawCerts[0]). Iterating the whole chain
			// (the previous behaviour) silently accepted any cert in the
			// path — including the issuing CA — so a server presenting a
			// different leaf signed by the same intermediate would pass.
			// `FetchServerPin` already captures the leaf SPKI at enrollment
			// time so the round-trip is consistent.
			if len(rawCerts) == 0 {
				return errors.New("TLS pin check: no peer certificates")
			}
			cert, err := x509.ParseCertificate(rawCerts[0])
			if err != nil {
				return fmt.Errorf("TLS pin check: parse leaf failed: %w", err)
			}
			if strings.EqualFold(spkiSHA256Hex(cert), expect) {
				return nil
			}
			return fmt.Errorf("TLS pin mismatch — leaf SPKI does not match pinned value %s", expect[:16])
		}
	}

	transport := &http.Transport{
		TLSClientConfig:       tlsCfg,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		MaxIdleConnsPerHost:   2,
		ForceAttemptHTTP2:     true,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
	}
	return &http.Client{
		Timeout:   45 * time.Second, // overall request deadline
		Transport: transport,
		// Refuse all redirects. The /api/rmm/* server endpoints have no
		// documented redirect semantics; following them would let a
		// misconfigured server or a downstream proxy chain the agent's
		// bearer-authenticated checkin / binary download through hosts
		// the operator never intended. Returning ErrUseLastResponse
		// gives the caller the 3xx response so they can decide.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// spkiSHA256Hex returns the hex SHA-256 of a cert's SubjectPublicKeyInfo.
// This is the standard "public-key pin" value — it stays valid across
// cert renewals that reuse the same key pair (the recommended rotation
// model) and breaks when the key actually changes, which is when you
// want the agent to refuse.
func spkiSHA256Hex(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return hex.EncodeToString(sum[:])
}

// ClientWithPin returns an HTTP client that enforces an SPKI pin.
// Used for one-off requests (enrollment) with a short overall timeout.
func ClientWithPin(pin string, timeout time.Duration) *http.Client {
	c := buildHTTPClient(pin)
	c.Timeout = timeout
	return c
}

// PlainHTTPSClient returns an HTTP client with no pin and standard TLS
// verification (or insecure if requested). Only used during the
// enrollment window if no pin is requested.
func PlainHTTPSClient(insecure bool, timeout time.Duration) *http.Client {
	c := buildHTTPClient("")
	if insecure {
		//nolint:gosec // explicit user request, enrollment-only
		c.Transport.(*http.Transport).TLSClientConfig.InsecureSkipVerify = true
	}
	c.Timeout = timeout
	return c
}

// FetchServerPin opens a single TLS connection to host:port and returns
// the SHA-256 of the leaf certificate's SPKI. Used during --enroll to
// lock in the server's identity. Standard TLS verification is performed
// first (so we don't pin a MITM'd cert), unless `insecure` is true.
func FetchServerPin(addr string, insecure bool) (string, error) {
	if !strings.Contains(addr, ":") {
		addr = addr + ":443"
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: insecure, //nolint:gosec // explicit flag for self-signed during pin capture
	})
	if err != nil {
		return "", err
	}
	defer conn.Close()
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return "", errors.New("server presented no certificate")
	}
	return spkiSHA256Hex(certs[0]), nil
}
