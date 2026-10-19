package checkin

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/itcake/agent/internal/commands"
	"github.com/itcake/agent/internal/config"
)

// signCommandForTest mirrors the server's HMAC message so tests can build
// commands that pass VerifySignature.
func signCommandForTest(id, agentID, cmdType, payload, issuedAt, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%s:%s:%s:%s:%s", id, agentID, cmdType, payload, issuedAt)
	return hex.EncodeToString(mac.Sum(nil))
}

func testCommand(id, agentID, cmdType, payloadRaw, secret string) PendingCommand {
	issuedAt := time.Now().UTC().Format(time.RFC3339)
	return PendingCommand{
		ID: id, AgentID: agentID, Type: cmdType, PayloadRaw: payloadRaw,
		IssuedAt:  issuedAt,
		Signature: signCommandForTest(id, agentID, cmdType, payloadRaw, issuedAt, secret),
	}
}

// Regression: the transient nack used to be dropped in the
// commands.Result -> commandResult conversion, so the server treated a
// retryable "worker pool full" as a final failure.
func TestToCommandResult_CarriesTransientFlag(t *testing.T) {
	body, err := json.Marshal(toCommandResult("cmd-1", transientNackResult("worker pool queue full")))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"transient":true`) {
		t.Fatalf("transient nack must serialize transient=true, got %s", body)
	}

	body, err = json.Marshal(toCommandResult("cmd-2", &commands.Result{Status: "completed"}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "transient") {
		t.Fatalf("final result must omit transient, got %s", body)
	}
}

func TestCmdRegistry_InFlightRedeliveryQueuesRunningAck(t *testing.T) {
	registry := newCmdRegistry()
	registry.begin("cmd-1")

	if action := registry.onRedelivery("cmd-1"); action != redeliveryHandled {
		t.Fatalf("in-flight redelivery action = %v, want redeliveryHandled", action)
	}
	queued := registry.drain(maxResultsPerCheckin)
	if len(queued) != 1 || queued[0].res.Status != "running" {
		t.Fatalf("want one running ack, got %+v", queued)
	}
	if queued[0].res.StartedAt == "" {
		t.Fatal("running ack must carry startedAt")
	}

	// The ack must not retire the tracking entry: the command is still in
	// flight and a later redelivery must be resolved too.
	registry.ack(queued)
	if action := registry.onRedelivery("cmd-1"); action != redeliveryHandled {
		t.Fatalf("second redelivery action = %v, want redeliveryHandled", action)
	}
	if queued = registry.drain(maxResultsPerCheckin); len(queued) != 1 || queued[0].res.Status != "running" {
		t.Fatalf("want another running ack after the second redelivery, got %+v", queued)
	}
}

// A redelivery of a command already in flight must re-ack it as running.
// The old code reported `failed` ("command replay rejected"), marking live
// work as rejected on the server.
func TestProcessCommands_RedeliveredInFlightCommandAckedRunning(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	const agentID = "agent-1"

	cmd := testCommand("cmd-1", agentID, "system_info_refresh", "{}", secret)
	replay := commands.NewReplayCache(10 * time.Minute)
	if !replay.Check(cmd.ID) {
		t.Fatal("first delivery must pass the replay cache")
	}
	registry := newCmdRegistry()
	registry.begin(cmd.ID) // accepted on the first delivery

	processCommands(&config.Config{AgentID: agentID, HMACSecret: secret}, replay, registry, []PendingCommand{cmd})

	queued := registry.drain(maxResultsPerCheckin)
	if len(queued) != 1 {
		t.Fatalf("want a single re-ack for the redelivery, got %+v", queued)
	}
	if queued[0].res.Status != "running" {
		t.Fatalf("status = %q, want running (stderr=%q)", queued[0].res.Status, queued[0].res.Stderr)
	}
}

// A replay of a command this process never accepted stays a security
// rejection — the registry answer must not weaken the replay cache.
func TestProcessCommands_UnknownReplayStillRejected(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	const agentID = "agent-1"

	cmd := testCommand("cmd-1", agentID, "system_info_refresh", "{}", secret)
	replay := commands.NewReplayCache(10 * time.Minute)
	if !replay.Check(cmd.ID) {
		t.Fatal("first delivery must pass the replay cache")
	}
	registry := newCmdRegistry() // no tracked state for cmd-1

	processCommands(&config.Config{AgentID: agentID, HMACSecret: secret}, replay, registry, []PendingCommand{cmd})

	queued := registry.drain(maxResultsPerCheckin)
	if len(queued) != 1 || queued[0].res.Status != "failed" {
		t.Fatalf("want one failed result, got %+v", queued)
	}
	if !strings.Contains(queued[0].res.Stderr, "command replay rejected") {
		t.Fatalf("stderr = %q, want replay rejection", queued[0].res.Stderr)
	}
}

func TestCmdRegistry_NackedRedeliveryRetriesInsteadOfRejecting(t *testing.T) {
	registry := newCmdRegistry()
	registry.nack("cmd-1", transientNackResult("worker pool queue full"))

	queued := registry.drain(maxResultsPerCheckin)
	if len(queued) != 1 || !queued[0].res.Transient {
		t.Fatalf("nack must be queued as a transient result, got %+v", queued)
	}

	// The response carrying the nack redelivers the command: it may be
	// dispatched again, never failed as a replay.
	if action := registry.onRedelivery("cmd-1"); action != redeliveryRetry {
		t.Fatalf("nacked redelivery action = %v, want redeliveryRetry", action)
	}

	registry.begin("cmd-1") // re-dispatch replaces the nacked entry
	registry.ack(queued)    // confirms the delivered nack; entry identity changed
	if left := registry.drain(maxResultsPerCheckin); len(left) != 0 {
		t.Fatalf("stale nack must not requeue after re-dispatch, got %+v", left)
	}

	if action := registry.onRedelivery("cmd-unknown"); action != redeliveryReplay {
		t.Fatalf("unknown id action = %v, want redeliveryReplay", action)
	}
}

// Results produced by one dispatch wave ride the next checkin payload, so
// the whole wave costs a single request; a successful checkin retires them.
func TestProcessCommands_ResultsRideOneCheckinRequest(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	const agentID = "agent-1"

	replay := commands.NewReplayCache(10 * time.Minute)
	registry := newCmdRegistry()
	cfg := &config.Config{AgentID: agentID, HMACSecret: secret}

	processCommands(cfg, replay, registry, []PendingCommand{
		testCommand("cmd-a", agentID, "system_info_refresh", "{}", secret),
		testCommand("cmd-b", agentID, "system_info_refresh", "{}", secret),
	})

	var mu sync.Mutex
	var bodies [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()
	cfg.ServerURL = srv.URL
	cfg.Token = "test-token"

	payload := &CheckinPayload{Hostname: "host-1"}
	queued := attachQueuedResults(payload, registry)
	if len(queued) != 2 {
		t.Fatalf("want both results queued for the checkin, got %d", len(queued))
	}
	if _, err := doCheckin(&http.Client{}, cfg, payload); err != nil {
		t.Fatalf("checkin failed: %v", err)
	}
	registry.ack(queued)

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("want exactly one checkin request for the wave, got %d", len(bodies))
	}
	var sent struct {
		CommandResults []commandResult `json:"commandResults"`
	}
	if err := json.Unmarshal(bodies[0], &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	if len(sent.CommandResults) != 2 {
		t.Fatalf("want 2 results in the single request body, got %d", len(sent.CommandResults))
	}
	for _, r := range sent.CommandResults {
		if r.Status != "completed" {
			t.Fatalf("cmd %s status = %q, want completed", r.ID, r.Status)
		}
	}
	if left := registry.drain(maxResultsPerCheckin); len(left) != 0 {
		t.Fatalf("acked results must not be resent, got %+v", left)
	}
}

// The drain stays within the server's commandResults cap so a larger wave
// spills into the following checkin instead of failing validation.
func TestCmdRegistry_DrainCapsAtServerLimit(t *testing.T) {
	registry := newCmdRegistry()
	for i := 0; i < maxResultsPerCheckin+5; i++ {
		registry.finish(fmt.Sprintf("cmd-%d", i), &commands.Result{Status: "completed"})
	}

	first := registry.drain(maxResultsPerCheckin)
	if len(first) != maxResultsPerCheckin {
		t.Fatalf("first drain = %d results, want %d", len(first), maxResultsPerCheckin)
	}
	registry.ack(first)
	if rest := registry.drain(maxResultsPerCheckin); len(rest) != 5 {
		t.Fatalf("leftover drain = %d results, want 5", len(rest))
	}
}

// An accepted command must always produce a result; a shell command with no
// payload used to return silently and stay pending forever.
func TestRunCommandTask_EmptyShellCommandReportsFailure(t *testing.T) {
	registry := newCmdRegistry()
	runCommandTask(context.Background(), registry, PendingCommand{ID: "cmd-1", Type: "shell"}, map[string]interface{}{}, 5)

	queued := registry.drain(maxResultsPerCheckin)
	if len(queued) != 1 || queued[0].res.Status != "failed" {
		t.Fatalf("want one failed result, got %+v", queued)
	}
	if !strings.Contains(queued[0].res.Stderr, "empty command") {
		t.Fatalf("stderr = %q, want it to mention the empty payload", queued[0].res.Stderr)
	}
}

// The cap must prefer evicting bookkeeping (in-flight marker, acked entry)
// over results the server has not seen yet: dropping an undelivered result
// would leave that command pending forever.
func TestCmdRegistry_CapEvictsBookkeepingBeforeUndeliveredResults(t *testing.T) {
	registry := newCmdRegistry()
	const done = 10
	for i := 0; i < done; i++ {
		registry.finish(fmt.Sprintf("done-%d", i), &commands.Result{Status: "completed"})
	}
	for i := 0; i < maxTrackedCommands; i++ {
		registry.begin(fmt.Sprintf("flight-%d", i))
	}

	registry.mu.Lock()
	size := len(registry.entries)
	registry.mu.Unlock()
	if size != maxTrackedCommands {
		t.Fatalf("registry size = %d, want cap %d", size, maxTrackedCommands)
	}

	queued := registry.drain(maxResultsPerCheckin)
	if len(queued) != done {
		t.Fatalf("undelivered results = %d, want all %d to survive the cap", len(queued), done)
	}
	seen := make(map[string]bool, len(queued))
	for _, q := range queued {
		seen[q.id] = true
	}
	for i := 0; i < done; i++ {
		if id := fmt.Sprintf("done-%d", i); !seen[id] {
			t.Fatalf("result %s was evicted while bookkeeping survived", id)
		}
	}
}

// Bookkeeping older than the signature window is prunable (its redelivery
// could not pass freshness anyway); an entry still holding a result is not,
// no matter how old — the server may just not have fetched it yet.
func TestCmdRegistry_PruneExpiresStaleBookkeepingButKeepsResults(t *testing.T) {
	registry := newCmdRegistry()
	registry.begin("stale-flight")
	registry.finish("old-done", &commands.Result{Status: "completed"})

	registry.mu.Lock()
	registry.entries["stale-flight"].at = time.Now().Add(-commandMaxAge - time.Minute)
	registry.entries["old-done"].at = time.Now().Add(-commandMaxAge - time.Minute)
	registry.mu.Unlock()

	registry.begin("trigger") // any put runs pruneLocked

	registry.mu.Lock()
	_, staleThere := registry.entries["stale-flight"]
	_, doneThere := registry.entries["old-done"]
	registry.mu.Unlock()
	if staleThere {
		t.Fatal("stale in-flight bookkeeping must be pruned")
	}
	if !doneThere {
		t.Fatal("undelivered result must survive pruning regardless of age")
	}

	queued := registry.drain(maxResultsPerCheckin)
	if len(queued) != 1 || queued[0].id != "old-done" {
		t.Fatalf("want the old undelivered result queued, got %+v", queued)
	}
}
