.PHONY: build run test lint tidy generate clean

build:
	cd backend-go && go build -o bin/api ./cmd/api

run:
	cd backend-go && go run ./cmd/api

test:
	cd backend-go && go test ./...

lint:
	cd backend-go && golangci-lint run ./...

tidy:
	cd backend-go && go mod tidy

format:
	cd backend-go && go fmt ./...

clean:
	rm -rf backend-go/bin
