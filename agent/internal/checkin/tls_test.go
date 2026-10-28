package checkin

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// These tests exercise the SPKI pin against real TLS handshakes. They model
// the attack the pin exists to stop: a certificate that chains to a trusted
// (or compromised) CA but does not carry the pinned leaf key. A mock of
// VerifyPeerCertificate would not prove that the callback actually runs in the
// handshake path, so each case uses httptest.NewTLSServer with a generated CA.

type testPKI struct {
	caCert *x509.Certificate
	caKey  *ecdsa.PrivateKey
}

func newTestPKI(t *testing.T) *testPKI {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate CA key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "ITCake Test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create CA cert: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse CA cert: %v", err)
	}
	return &testPKI{caCert: cert, caKey: key}
}

func (p *testPKI) leaf(t *testing.T, cn string) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate leaf key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{cn},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.caCert, &key.PublicKey, p.caKey)
	if err != nil {
		t.Fatalf("create leaf cert: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse leaf cert: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: cert}, cert
}

func startTestTLSServer(t *testing.T, leaf tls.Certificate) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	srv.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{leaf},
	}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

func poolWith(certs ...*x509.Certificate) *x509.CertPool {
	pool := x509.NewCertPool()
	for _, cert := range certs {
		pool.AddCert(cert)
	}
	return pool
}

func TestPinnedClientAcceptsMatchingLeaf(t *testing.T) {
	pki := newTestPKI(t)
	leafTLS, leaf := pki.leaf(t, "itcake.test")
	srv := startTestTLSServer(t, leafTLS)

	client := buildHTTPClientWithRoots(spkiSHA256Hex(leaf), poolWith(pki.caCert))
	defer client.CloseIdleConnections()

	resp, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("matching pin should connect: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

func TestPinnedClientRejectsDifferentLeafFromTrustedCA(t *testing.T) {
	pki := newTestPKI(t)
	_, pinnedLeaf := pki.leaf(t, "itcake.test")
	otherTLS, _ := pki.leaf(t, "itcake.test")
	srv := startTestTLSServer(t, otherTLS)

	// Both leaves chain to the same CA, so normal chain validation succeeds.
	// Only the pin can distinguish them — this is the CA-compromise case.
	client := buildHTTPClientWithRoots(spkiSHA256Hex(pinnedLeaf), poolWith(pki.caCert))
	defer client.CloseIdleConnections()

	_, err := client.Get(srv.URL)
	if err == nil {
		t.Fatal("different leaf must be rejected even though its CA is trusted")
	}
	if !strings.Contains(err.Error(), "TLS pin mismatch") {
		t.Fatalf("error = %v, want TLS pin mismatch", err)
	}
}

func TestPinnedClientMatchesLeafOnlyNotIssuingCA(t *testing.T) {
	pki := newTestPKI(t)
	leafTLS, _ := pki.leaf(t, "itcake.test")
	srv := startTestTLSServer(t, leafTLS)

	// The old implementation iterated the whole chain, so pinning the CA
	// silently accepted every leaf it issued. The pin must match only the leaf.
	client := buildHTTPClientWithRoots(spkiSHA256Hex(pki.caCert), poolWith(pki.caCert))
	defer client.CloseIdleConnections()

	_, err := client.Get(srv.URL)
	if err == nil {
		t.Fatal("CA SPKI must not satisfy a leaf pin")
	}
	if !strings.Contains(err.Error(), "TLS pin mismatch") {
		t.Fatalf("error = %v, want TLS pin mismatch", err)
	}
}

func TestUnpinnedClientStillVerifiesChain(t *testing.T) {
	pki := newTestPKI(t)
	leafTLS, _ := pki.leaf(t, "itcake.test")
	srv := startTestTLSServer(t, leafTLS)

	trusted := buildHTTPClientWithRoots("", poolWith(pki.caCert))
	defer trusted.CloseIdleConnections()
	resp, err := trusted.Get(srv.URL)
	if err != nil {
		t.Fatalf("trusted CA should connect without a pin: %v", err)
	}
	resp.Body.Close()

	untrusted := buildHTTPClientWithRoots("", x509.NewCertPool())
	defer untrusted.CloseIdleConnections()
	if _, err := untrusted.Get(srv.URL); err == nil {
		t.Fatal("untrusted CA must be rejected when no pin is configured")
	}
}

func TestFetchServerPinReturnsLeafSPKI(t *testing.T) {
	pki := newTestPKI(t)
	leafTLS, leaf := pki.leaf(t, "itcake.test")
	srv := startTestTLSServer(t, leafTLS)

	pin, err := FetchServerPin(strings.TrimPrefix(srv.URL, "https://"), true)
	if err != nil {
		t.Fatalf("FetchServerPin: %v", err)
	}
	if want := spkiSHA256Hex(leaf); pin != want {
		t.Fatalf("pin = %s, want %s", pin, want)
	}
}
