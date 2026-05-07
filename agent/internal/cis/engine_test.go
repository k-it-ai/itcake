package cis

import (
	"context"
	"testing"
)

// We can't run platform-specific checks in cross-OS test, so we exercise
// the engine via a fake check list via the local-only platformChecks shim.

func TestRunBenchmark_AggregatesStatusesAndScore(t *testing.T) {
	checks := []Check{
		{ID: "P1", Title: "passing 1", Severity: SeverityHigh, Fn: func(_ context.Context) CheckResult { return CheckResult{Status: StatusPass} }},
		{ID: "P2", Title: "passing 2", Severity: SeverityMedium, Fn: func(_ context.Context) CheckResult { return CheckResult{Status: StatusPass} }},
		{ID: "F1", Title: "failing", Severity: SeverityHigh, Fn: func(_ context.Context) CheckResult { return CheckResult{Status: StatusFail, Message: "broken"} }},
		{ID: "N1", Title: "n/a", Severity: SeverityLow, Fn: func(_ context.Context) CheckResult { return CheckResult{Status: StatusNotApplicable} }},
		{ID: "E1", Title: "errored", Severity: SeverityLow, Fn: func(_ context.Context) CheckResult { return CheckResult{Status: StatusError, Message: "tool missing"} }},
	}

	out := runBenchmarkWithChecks(context.Background(), checks)

	if out.TotalChecks != 5 {
		t.Errorf("TotalChecks = %d, want 5", out.TotalChecks)
	}
	if out.PassedChecks != 2 {
		t.Errorf("PassedChecks = %d, want 2", out.PassedChecks)
	}
	if out.FailedChecks != 1 {
		t.Errorf("FailedChecks = %d, want 1", out.FailedChecks)
	}
	if out.NotApplicable != 1 {
		t.Errorf("NotApplicable = %d, want 1", out.NotApplicable)
	}
	if out.ErroredChecks != 1 {
		t.Errorf("ErroredChecks = %d, want 1", out.ErroredChecks)
	}
	// Score = 2 / (2+1) = 66
	if out.Score != 66 {
		t.Errorf("Score = %d, want 66", out.Score)
	}
	if out.CheckedAt == "" {
		t.Errorf("CheckedAt empty")
	}
}

func TestRunBenchmark_FillsInTitleAndSeverityFromCheck(t *testing.T) {
	checks := []Check{
		{ID: "T1", Title: "t1-title", Severity: SeverityHigh, Fn: func(_ context.Context) CheckResult {
			// Fn returns minimal result — engine should fill in title + severity.
			return CheckResult{Status: StatusFail}
		}},
	}
	out := runBenchmarkWithChecks(context.Background(), checks)
	if len(out.Findings) != 1 {
		t.Fatalf("findings = %d, want 1", len(out.Findings))
	}
	if out.Findings[0].Title != "t1-title" {
		t.Errorf("Title = %q, want t1-title", out.Findings[0].Title)
	}
	if out.Findings[0].Severity != SeverityHigh {
		t.Errorf("Severity = %v, want high", out.Findings[0].Severity)
	}
	if out.Findings[0].CheckID != "T1" {
		t.Errorf("CheckID = %q, want T1", out.Findings[0].CheckID)
	}
}
