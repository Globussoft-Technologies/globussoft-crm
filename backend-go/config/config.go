package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/kelseyhightower/envconfig"
)

// Config holds all environment-driven configuration for the Go backend.
// It mirrors the Node.js backend's env expectations so both backends can run
// side-by-side during the strangler-fig migration.
type Config struct {
	Env               string        `envconfig:"NODE_ENV" default:"development"`
	Port              string        `envconfig:"PORT" default:"5000"`
	DatabaseURL       string        `envconfig:"DATABASE_URL" required:"true"`
	JWTSecret         string        `envconfig:"JWT_SECRET" required:"true"`
	PortalJWTSecret   string        `envconfig:"PORTAL_JWT_SECRET" default:""`
	FrontendURL       string        `envconfig:"FRONTEND_URL" default:"http://localhost:5173"`
	CorsOrigins       string        `envconfig:"CORS_ALLOWED_ORIGINS" default:"*"`
	RedisAddr         string        `envconfig:"REDIS_ADDR" default:""`
	DisableCrons      bool          `envconfig:"DISABLE_CRONS" default:"false"`
	WellnessFieldKey  string        `envconfig:"WELLNESS_FIELD_KEY" default:""`
	LogLevel          string        `envconfig:"LOG_LEVEL" default:"info"`
	RequestTimeout    time.Duration `envconfig:"REQUEST_TIMEOUT" default:"30s"`
	ShutdownTimeout   time.Duration `envconfig:"SHUTDOWN_TIMEOUT" default:"30s"`
	RouteRegistryPath string        `envconfig:"ROUTE_REGISTRY_PATH" default:"./config/routes.yaml"`
}

// Load reads environment variables into Config and validates required fields.
func Load() (*Config, error) {
	var cfg Config
	if err := envconfig.Process("", &cfg); err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}
	if cfg.Env == "production" {
		if cfg.JWTSecret == "" {
			return nil, fmt.Errorf("JWT_SECRET must be set in production")
		}
		if cfg.PortalJWTSecret == "" {
			fmt.Println("[startup] PORTAL_JWT_SECRET not set — patient portal tokens will reuse JWT_SECRET")
		}
	}
	return &cfg, nil
}

// ParseCorsOrigins splits the comma-separated CORS_ALLOWED_ORIGINS value.
func (c *Config) ParseCorsOrigins() []string {
	if c.CorsOrigins == "" || c.CorsOrigins == "*" {
		return []string{"*"}
	}
	return splitAndTrim(c.CorsOrigins, ",")
}

// AppVersion returns the backend version.
// It reads from the Node.js backend package.json when running from the repo root
// or from backend-go/ so the Go health endpoint reports the same version during migration.
func AppVersion() string {
	const defaultVersion = "3.9.3"
	candidates := []string{
		"backend/package.json",
		"../backend/package.json",
		"../../backend/package.json",
	}
	for _, p := range candidates {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var pkg struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(b, &pkg); err == nil && pkg.Version != "" {
			return pkg.Version
		}
	}
	return defaultVersion
}

func splitAndTrim(s, sep string) []string {
	parts := make([]string, 0)
	for _, p := range strings.Split(s, sep) {
		if t := strings.TrimSpace(p); t != "" {
			parts = append(parts, t)
		}
	}
	return parts
}

// Atoi wraps strconv.Atoi with a default fallback.
func Atoi(s string, fallback int) int {
	if s == "" {
		return fallback
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return fallback
	}
	return v
}
