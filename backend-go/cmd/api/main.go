package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/config"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/app"
	"github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/handlers"
	"github.com/sirupsen/logrus"
)

func main() {
	bootTime := time.Now()
	handlers.SetServerStartTime(bootTime)
	app.BootTime = bootTime

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config load failed: %v\n", err)
		os.Exit(1)
	}

	logger := logrus.New()
	logger.Infof("starting Go CRM API on port %s env=%s version=%s", cfg.Port, cfg.Env, config.AppVersion())

	srv, err := app.NewServer(cfg)
	if err != nil {
		logger.Fatalf("server init failed: %v", err)
	}

	go func() {
		if err := srv.Engine().Start(":" + cfg.Port); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("server start failed: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down Go CRM API")
	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Errorf("server shutdown failed: %v", err)
		os.Exit(1)
	}
}
