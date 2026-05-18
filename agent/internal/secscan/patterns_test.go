package secscan

import "testing"

func TestPatternMatches(t *testing.T) {
	cases := []struct {
		name      string
		patternID string
		positive  string
		negative  string
		needsLuhn bool
	}{
		{"ssn", "pii_ssn", "DOB 1990; SSN 123-45-6789 on file", "SSN: 12-345-6789", false},
		{"email", "pii_email", "Contact me at foo@example.com today", "no email here", false},
		{"aws", "credential_aws_access_key", `AWS_KEY="AKIAIOSFODNN7EXAMPLE"`, "AKIA short", false},
		{"private key", "credential_private_key", "-----BEGIN OPENSSH PRIVATE KEY-----\n", "BEGIN PUBLIC KEY", false},
		{"secret assignment", "credential_secret_assignment", `password = "supersecret123"`, `password=""`, false},
		{"phi", "phi_medical_reference", "patient diagnosis pending", "no phi here", false},
		{"iban", "financial_iban", "IBAN GB82WEST12345698765432", "AB1 not iban", false},
		{"pci valid luhn", "pci_card_number", "card 4111111111111111 used", "card 1234567890123 invalid", true},
	}
	for _, c := range cases {
		t.Run(c.name+"_pos", func(t *testing.T) {
			pat := findPattern(c.patternID)
			if pat == nil {
				t.Fatalf("pattern not found: %s", c.patternID)
			}
			match := pat.RE.FindString(c.positive)
			if match == "" {
				t.Errorf("%s: expected match in %q", c.patternID, c.positive)
			}
			if c.needsLuhn && !LuhnValid(match) {
				t.Errorf("%s: Luhn rejected real number %q", c.patternID, match)
			}
		})
		t.Run(c.name+"_neg", func(t *testing.T) {
			pat := findPattern(c.patternID)
			if pat == nil {
				t.Fatalf("pattern not found: %s", c.patternID)
			}
			match := pat.RE.FindString(c.negative)
			if c.needsLuhn {
				if match != "" && LuhnValid(match) {
					t.Errorf("%s: Luhn accepted bad number %q", c.patternID, match)
				}
			} else if match != "" {
				t.Errorf("%s: unexpected match %q in %q", c.patternID, match, c.negative)
			}
		})
	}
}

func findPattern(id string) *Pattern {
	for i := range Patterns {
		if Patterns[i].ID == id {
			return &Patterns[i]
		}
	}
	return nil
}

func TestLuhnEdgeCases(t *testing.T) {
	cases := []struct {
		s    string
		want bool
	}{
		{"4111111111111111", true},
		{"4111-1111-1111-1111", true},
		{"4111 1111 1111 1112", false},
		{"79927398713", false},
		{"4012888888881881", true},
		{"123", false},
		{"", false},
		{"00000000000000000000", false},
	}
	for _, c := range cases {
		got := LuhnValid(c.s)
		if got != c.want {
			t.Errorf("LuhnValid(%q) = %v; want %v", c.s, got, c.want)
		}
	}
}

func TestSanitizeSampleSSN(t *testing.T) {
	got := SanitizeSample("pii_ssn", "123-45-6789")
	if got != "***-**-****" {
		t.Errorf("want masked SSN, got %q", got)
	}
}

func TestSanitizeSamplePCI(t *testing.T) {
	got := SanitizeSample("pci_card_number", "4111-1111-1111-1111")
	if got != "****-****-****-****" {
		t.Errorf("want masked PCI, got %q", got)
	}
}

func TestSanitizeSampleEmail(t *testing.T) {
	got := SanitizeSample("pii_email", "foo@bar.com")
	if got != "f[REDACTED]@bar.com" {
		t.Errorf("want partially redacted email, got %q", got)
	}
	short := SanitizeSample("pii_email", "a@b.co")
	if short != "[REDACTED]" {
		t.Errorf("want fully redacted short email, got %q", short)
	}
}

func TestSanitizeSampleAWSKey(t *testing.T) {
	got := SanitizeSample("credential_aws_access_key", "AKIAIOSFODNN7EXAMPLE")
	if got != "AKIA[REDACTED]" {
		t.Errorf("want prefix-only AWS key, got %q", got)
	}
}

func TestSanitizeSamplePrivateKey(t *testing.T) {
	got := SanitizeSample("credential_private_key", "-----BEGIN OPENSSH PRIVATE KEY-----")
	if got != "-----BEGIN PRIVATE KEY----- [REDACTED]" {
		t.Errorf("want redacted PEM header, got %q", got)
	}
}

func TestSanitizeSampleSecretAssignment(t *testing.T) {
	got := SanitizeSample("credential_secret_assignment", `password = "supersecret123"`)
	if got != "password = [REDACTED]" {
		t.Errorf("want redacted RHS, got %q", got)
	}
}

func TestSanitizeSampleIBAN(t *testing.T) {
	got := SanitizeSample("financial_iban", "GB82WEST12345698765432")
	if got != "GB82[REDACTED]" {
		t.Errorf("want country-code-only IBAN, got %q", got)
	}
}

func TestSanitizeSampleUnknownPassthrough(t *testing.T) {
	got := SanitizeSample("phi_medical_reference", "patient diagnosis pending")
	if got != "patient diagnosis pending" {
		t.Errorf("unknown patternID should pass through, got %q", got)
	}
}
