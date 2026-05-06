// Package secscan walks operator-specified paths and reports files
// matching a regex catalogue of credentials / PII / PCI / PHI / financial
// data. Detection only — no encrypt / quarantine / secure-delete.
// Operator marks findings accepted/false_positive on the server side.
package secscan

import "regexp"

// Severity matches the server-side severity enum.
type Severity string

const (
	SeverityLow      Severity = "low"
	SeverityMedium   Severity = "medium"
	SeverityHigh     Severity = "high"
	SeverityCritical Severity = "critical"
)

// Pattern is a single detection rule. MaxMatchesPerFile caps the
// per-file output so a noisy file (e.g. a debug log full of email
// addresses) doesn't dominate the result set.
type Pattern struct {
	ID                string
	RE                *regexp.Regexp
	Severity          Severity
	MaxMatchesPerFile int
	NeedsLuhn         bool
}

// Patterns ported verbatim from the Breeze catalogue. Each one is a
// best-effort detector — false positives are expected (especially
// pci_card_number, which Luhn-validates to cut the noise down).
var Patterns = []Pattern{
	{ID: "pii_ssn", RE: regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`), Severity: SeverityHigh, MaxMatchesPerFile: 50},
	{ID: "pii_email", RE: regexp.MustCompile(`(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b`), Severity: SeverityLow, MaxMatchesPerFile: 50},
	{ID: "pci_card_number", RE: regexp.MustCompile(`\b(?:\d[ -]*?){13,19}\b`), Severity: SeverityCritical, MaxMatchesPerFile: 50, NeedsLuhn: true},
	{ID: "phi_medical_reference", RE: regexp.MustCompile(`(?i)\b(?:mrn|medical record|diagnosis|patient id)\b`), Severity: SeverityHigh, MaxMatchesPerFile: 50},
	{ID: "credential_aws_access_key", RE: regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`), Severity: SeverityCritical, MaxMatchesPerFile: 50},
	{ID: "credential_private_key", RE: regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`), Severity: SeverityCritical, MaxMatchesPerFile: 5},
	{ID: "credential_secret_assignment", RE: regexp.MustCompile(`(?i)(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}["']`), Severity: SeverityHigh, MaxMatchesPerFile: 50},
	{ID: "financial_iban", RE: regexp.MustCompile(`\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b`), Severity: SeverityMedium, MaxMatchesPerFile: 50},
}

// LuhnValid implements the Luhn checksum used to validate credit-card
// numbers. Any non-digit characters are stripped before validation.
// Returns false for inputs shorter than 13 or longer than 19 digits.
func LuhnValid(s string) bool {
	digits := make([]int, 0, 19)
	for _, r := range s {
		if r >= '0' && r <= '9' {
			digits = append(digits, int(r-'0'))
		}
	}
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	sum := 0
	parity := len(digits) % 2
	for i, d := range digits {
		if i%2 == parity {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
	}
	return sum%10 == 0
}

// SanitizeSample replaces digits with '*' for SSN and PCI patterns so
// raw numbers never land in the audit trail. Other pattern types pass
// through. Caller truncates the result to the per-row sample length
// (server-side cap is 64 bytes).
func SanitizeSample(patternID, sample string) string {
	switch patternID {
	case "pii_ssn", "pci_card_number":
		out := []rune(sample)
		for i, r := range out {
			if r >= '0' && r <= '9' {
				out[i] = '*'
			}
		}
		return string(out)
	}
	return sample
}
