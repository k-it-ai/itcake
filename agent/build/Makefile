VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
# Build-time flags, matching server-side builder (see src/lib/server/agent-build.ts):
#  -s -w             strip debug/symbols (smaller, standard practice)
#  -trimpath         reproducible builds; no absolute paths embedded
#  -buildvcs=false   don't embed git state — enables deterministic hashing
#  -X main.version=  inject release tag for `itcake-agent version`
LDFLAGS := -s -w -X main.version=$(VERSION)
GOFLAGS := -trimpath -buildvcs=false -ldflags="$(LDFLAGS)"
# CGO_ENABLED=0 -> static binaries; required for cross-compile without a C toolchain.
BUILD   := CGO_ENABLED=0 go build $(GOFLAGS)
OUT_DIR := ../dist

.PHONY: all clean darwin-amd64 darwin-arm64 linux-amd64 linux-arm64 windows-amd64 windows-arm64

all: darwin-amd64 darwin-arm64 linux-amd64 linux-arm64 windows-amd64 windows-arm64

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

darwin-amd64: $(OUT_DIR)
	cd .. && GOOS=darwin GOARCH=amd64 $(BUILD) -o dist/itcake-agent-darwin-amd64 ./cmd/agent

darwin-arm64: $(OUT_DIR)
	cd .. && GOOS=darwin GOARCH=arm64 $(BUILD) -o dist/itcake-agent-darwin-arm64 ./cmd/agent

linux-amd64: $(OUT_DIR)
	cd .. && GOOS=linux GOARCH=amd64 $(BUILD) -o dist/itcake-agent-linux-amd64 ./cmd/agent

linux-arm64: $(OUT_DIR)
	cd .. && GOOS=linux GOARCH=arm64 $(BUILD) -o dist/itcake-agent-linux-arm64 ./cmd/agent

# Windows: note the .exe suffix — required so Defender treats the file as
# a Windows executable (no-suffix binaries trigger heuristic detection).
windows-amd64: $(OUT_DIR)
	cd .. && GOOS=windows GOARCH=amd64 $(BUILD) -o dist/itcake-agent-windows-amd64.exe ./cmd/agent

windows-arm64: $(OUT_DIR)
	cd .. && GOOS=windows GOARCH=arm64 $(BUILD) -o dist/itcake-agent-windows-arm64.exe ./cmd/agent

clean:
	rm -rf $(OUT_DIR)
