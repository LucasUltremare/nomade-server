VERSION ?= dev
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: web build demo dev test release clean

web:
	npm --prefix web run build

build: web
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/mia ./cmd/mia

# Sobe o Mia com um Proxmox falso em https://127.0.0.1:8443
demo: build
	./bin/mia serve --demo --listen 127.0.0.1:8443

# Backend demo + Vite com hot reload em http://localhost:5173
dev:
	go run ./cmd/mia serve --demo --listen 127.0.0.1:8443 & npm --prefix web run dev; kill %1

test:
	go vet ./...
	go test ./...

# Binários linux estáticos + checksums, no formato que o install.sh espera.
release:
	rm -rf dist && mkdir -p dist
	for arch in amd64 arm64; do \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" -o dist/mia ./cmd/mia && \
		tar -czf dist/mia_linux_$$arch.tar.gz -C dist mia && rm dist/mia; \
	done
	cd dist && sha256sum mia_linux_*.tar.gz > checksums.txt 2>/dev/null || shasum -a 256 mia_linux_*.tar.gz > checksums.txt

clean:
	rm -rf bin dist .mia-demo web/dist/assets web/dist/index.html web/dist/favicon.svg
