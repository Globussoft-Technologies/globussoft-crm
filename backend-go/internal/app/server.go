package app

import (
	"context"
	"fmt"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/config"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/handlers"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/middleware"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/repository"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/services"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/shared"
	"github.com/labstack/echo/v4"
	"github.com/sirupsen/logrus"
)

// Server holds the Echo engine and dependencies.
type Server struct {
	cfg    *config.Config
	e      *echo.Echo
	db     *repository.DB
	logger *logrus.Logger
	rbac   services.RBACService
}

// NewServer creates a configured Server.
func NewServer(cfg *config.Config) (*Server, error) {
	logger := logrus.New()
	level, err := logrus.ParseLevel(cfg.LogLevel)
	if err != nil {
		level = logrus.InfoLevel
	}
	logger.SetLevel(level)

	db, err := repository.NewDB(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("database init failed: %w", err)
	}

	rbacSvc := services.NewRBACService(db.DB)

	e := echo.New()
	e.HideBanner = true
	e.HidePort = true
	e.HTTPErrorHandler = middleware.HTTPErrorHandler

	// Middleware chain order mirrors backend/server.js as closely as possible.
	e.Use(middleware.RequestID())
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORS(cfg.ParseCorsOrigins()))
	e.Use(middleware.SecurityHeaders())
	e.Use(middleware.BodyLimit())
	e.Use(middleware.Gzip())
	e.Use(middleware.StripTrailingSlash())
	e.Use(middleware.OriginCheck(cfg.FrontendURL))
	e.Use(middleware.TenantMiddleware(db.DB))
	e.Use(middleware.Auth(&middleware.AuthConfig{
		JWTSecret:        cfg.JWTSecret,
		RevokedTokenRepo: repository.NewRevokedTokenRepository(db),
		Logger:           logger,
	}))
	e.Use(middleware.StripDangerous())
	e.Use(middleware.SanitizeBody())
	e.Use(middleware.ScrubResponseMiddleware())
	// Expose RBAC service to middleware via Echo context.
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			middleware.SetRBAC(c, rbacSvc)
			return next(c)
		}
	})

	s := &Server{
		cfg:    cfg,
		e:      e,
		db:     db,
		logger: logger,
		rbac:   rbacSvc,
	}
	s.registerRoutes()
	return s, nil
}

// Engine returns the underlying Echo instance.
func (s *Server) Engine() *echo.Echo {
	return s.e
}

// Logger returns the server logger.
func (s *Server) Logger() *logrus.Logger {
	return s.logger
}

// DB returns the database handle.
func (s *Server) DB() *repository.DB {
	return s.db
}

// Shutdown gracefully stops the server.
func (s *Server) Shutdown(ctx context.Context) error {
	if err := s.e.Shutdown(ctx); err != nil {
		return err
	}
	if s.db != nil {
		return s.db.Close()
	}
	return nil
}

func (s *Server) registerRoutes() {
	// Open / health routes.
	hh := handlers.NewHealthHandler(s.db)
	s.e.GET("/", hh.Root)
	s.e.GET("/api/health", hh.Health)

	// Audit routes (ADMIN only).
	auditRepo := repository.NewAuditRepository(s.db)
	auditSvc := services.NewAuditService(auditRepo)
	ah := handlers.NewAuditHandler(auditSvc)
	auditGroup := s.e.Group("/api/audit", middleware.RequirePermissionOrRole("audit", "read", "ADMIN", "OWNER"))
	auditGroup.GET("", ah.List)
	auditGroup.GET("/verify", ah.Verify)

	// JSON 404 for unmatched /api/* paths.
	s.e.Any("/api/*", func(c echo.Context) error {
		return shared.ErrNotFound(c)
	})
}

// BootTime is set by cmd/api/main.go for uptime reporting.
var BootTime = time.Now()
