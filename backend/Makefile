# Backend Makefile

.PHONY: run build tidy test lint admin-migrate admin-seed

run:
	go run ./app/services/api

build:
	go build -o bin/api ./app/services/api
	go build -o bin/admin ./app/tooling/admin
	go build -o bin/indexer ./app/tooling/indexer

tidy:
	go mod tidy

test:
	go test -v -race -count=1 ./...

lint:
	golangci-lint run ./...

admin-migrate:
	go run ./app/tooling/admin migrate

admin-seed:
	go run ./app/tooling/admin seed

generate-key:
	@mkdir -p zarf/keys
	openssl genrsa -traditional -out zarf/keys/default.pem 2048
	@echo "Key generated at zarf/keys/default.pem"
