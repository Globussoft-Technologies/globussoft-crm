# Build stage
FROM golang:1.24-alpine AS builder

ARG APP_VERSION=3.9.3
ENV APP_VERSION=${APP_VERSION}

RUN apk add --no-cache git ca-certificates

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o /bin/api ./cmd/api

# Runtime stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates
WORKDIR /app

COPY --from=builder /bin/api /app/api

EXPOSE 5000

CMD ["./api"]
