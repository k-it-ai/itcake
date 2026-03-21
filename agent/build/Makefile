VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -s -w -X main.version=$(VERSION)
BUILD := CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)"
OUT_DIR := ../dist

.PHONY: all clean darwin-amd64 darwin-arm64 linux-amd64 linux-arm64

all: darwin-amd64 darwin-arm64 linux-amd64 linux-arm64

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

clean:
	rm -rf $(OUT_DIR)
