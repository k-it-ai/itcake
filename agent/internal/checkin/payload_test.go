package checkin

import (
	"encoding/json"
	"strings"
	"testing"
)

// The server's check-in schema requires packages/services to be arrays when
// present. An empty inventoryResult must therefore be omitted, not encoded as
// null. Windows collectors can legitimately return nothing, which used to make
// every inventory check-in fail with HTTP 400 after the first heartbeat.
func TestAttachInventoryOmitsEmptyCollections(t *testing.T) {
	payload := &CheckinPayload{Hostname: "host-1"}
	attachInventory(payload, inventoryResult{})

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	for _, field := range []string{`"packages":null`, `"services":null`, `"events":null`} {
		if strings.Contains(string(body), field) {
			t.Fatalf("payload contains %s: %s", field, body)
		}
	}
}

func TestAttachInventoryIncludesNonEmptyCollections(t *testing.T) {
	payload := &CheckinPayload{Hostname: "host-1"}
	attachInventory(payload, inventoryResult{
		Packages: []map[string]interface{}{{"manager": "apt", "name": "curl"}},
		Services: []map[string]interface{}{{"name": "sshd", "status": "running"}},
	})

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	for _, field := range []string{`"packages":[`, `"services":[`} {
		if !strings.Contains(string(body), field) {
			t.Fatalf("payload is missing %s: %s", field, body)
		}
	}
}
