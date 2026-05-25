// Package cis implements a small subset (~10 per OS) of CIS Benchmark
// Level-1 checks. Detection only — no remediation.
package cis

import (
	"context"
	"time"
)

type Status string

const (
	StatusPass         Status = "pass"
	StatusFail         Status = "fail"
	StatusNotApplicable Status = "not_applicable"
	StatusError        Status = "error"
)

type Severity string

const (
	SeverityHigh   Severity = "high"
	SeverityMedium Severity = "medium"
	SeverityLow    Severity = "low"
)

// Check is one CIS audit check. Fn must tolerate missing tools (StatusError, no panic).
type Check struct {
	ID       string
	Title    string
	Severity Severity
	Fn       func(ctx context.Context) CheckResult
}

// CheckResult is the per-check output.
type CheckResult struct {
	CheckID  string   `json:"checkId"`
	Title    string   `json:"title"`
	Severity Severity `json:"severity"`
	Status   Status   `json:"status"`
	Message  string   `json:"message,omitempty"`
	Evidence string   `json:"evidence,omitempty"`
}

// BenchmarkOutput is the full audit JSON the agent emits for cis_audit.
type BenchmarkOutput struct {
	CheckedAt     string        `json:"checkedAt"`
	Platform      string        `json:"platform"`
	TotalChecks   int           `json:"totalChecks"`
	PassedChecks  int           `json:"passedChecks"`
	FailedChecks  int           `json:"failedChecks"`
	NotApplicable int           `json:"notApplicable"`
	ErroredChecks int           `json:"erroredChecks"`
	Score         int           `json:"score"`
	Findings      []CheckResult `json:"findings"`
}

// RunBenchmark executes platform-specific checks (10s each) and aggregates.
func RunBenchmark(ctx context.Context) BenchmarkOutput {
	return runBenchmarkWithChecks(ctx, platformChecks())
}

func runBenchmarkWithChecks(ctx context.Context, checks []Check) BenchmarkOutput {
	out := BenchmarkOutput{
		CheckedAt: time.Now().UTC().Format(time.RFC3339),
		Platform:  platformName(),
		Findings:  make([]CheckResult, 0, len(checks)),
	}
	for _, c := range checks {
		select {
		case <-ctx.Done():
			out.Findings = append(out.Findings, CheckResult{
				CheckID: c.ID, Title: c.Title, Severity: c.Severity,
				Status: StatusError, Message: "context canceled",
			})
			out.ErroredChecks++
			continue
		default:
		}
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		r := c.Fn(cctx)
		cancel()
		if r.CheckID == "" {
			r.CheckID = c.ID
		}
		if r.Title == "" {
			r.Title = c.Title
		}
		if r.Severity == "" {
			r.Severity = c.Severity
		}
		out.Findings = append(out.Findings, r)
		switch r.Status {
		case StatusPass:
			out.PassedChecks++
		case StatusFail:
			out.FailedChecks++
		case StatusNotApplicable:
			out.NotApplicable++
		case StatusError:
			out.ErroredChecks++
		}
	}
	out.TotalChecks = len(checks)
	considered := out.PassedChecks + out.FailedChecks
	if considered > 0 {
		out.Score = (out.PassedChecks * 100) / considered
	}
	return out
}
