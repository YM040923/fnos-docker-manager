package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNormalizeConfigMigratesLegacyDefaults(t *testing.T) {
	cfg := normalizeConfig(Config{
		Version: 1,
		Settings: Settings{
			CheckIntervalSeconds:     1,
			StartupRetryDelaySeconds: 1,
			StartupTimeoutSeconds:    1,
		},
		Containers: map[string]ContainerConfig{
			"abc": {
				Enabled:             true,
				StartupOrder:        5,
				StartupDelaySeconds: 2,
				Monitor:             true,
			},
		},
	})

	if cfg.Version != currentConfigVersion {
		t.Fatalf("expected version %d, got %d", currentConfigVersion, cfg.Version)
	}
	if !cfg.Settings.AutoRunOnStart {
		t.Fatal("legacy config should enable autoRunOnStart")
	}
	if !cfg.Settings.ProtectManagerContainers {
		t.Fatal("legacy config should enable manager container protection")
	}
	if cfg.Settings.CheckIntervalSeconds != 10 {
		t.Fatalf("expected clamped check interval 10, got %d", cfg.Settings.CheckIntervalSeconds)
	}
	item := cfg.Containers["abc"]
	if item.ReadinessMode != readinessAuto {
		t.Fatalf("expected readiness auto, got %q", item.ReadinessMode)
	}
	if item.FailurePolicy != policyRetry {
		t.Fatalf("expected policy retry, got %q", item.FailurePolicy)
	}
}

func TestNormalizeConfigPreservesVersionTwoFalseBooleans(t *testing.T) {
	cfg := normalizeConfig(Config{
		Version: currentConfigVersion,
		Settings: Settings{
			AutoRunOnStart:           false,
			ProtectManagerContainers: false,
			LogRetentionLines:        20,
		},
		Containers: map[string]ContainerConfig{},
	})

	if cfg.Settings.AutoRunOnStart {
		t.Fatal("version 2 false autoRunOnStart should be preserved")
	}
	if cfg.Settings.ProtectManagerContainers {
		t.Fatal("version 2 false protection should be preserved")
	}
	if cfg.Settings.LogRetentionLines != 100 {
		t.Fatalf("expected retention clamped to 100, got %d", cfg.Settings.LogRetentionLines)
	}
}

func TestMergeDiscoveredStoresMetadataAndAddsStaleEntries(t *testing.T) {
	cfg := normalizeConfig(Config{
		Version: currentConfigVersion,
		Settings: Settings{
			AutoRunOnStart:           true,
			ProtectManagerContainers: true,
		},
		Containers: map[string]ContainerConfig{
			"old": {
				Enabled:       true,
				Name:          "old-service",
				Image:         "example/old:latest",
				StartupOrder:  5,
				Monitor:       true,
				ReadinessMode: readinessAuto,
				FailurePolicy: policyRetry,
			},
		},
	})
	discovered := []Container{{
		ID:             "new",
		Name:           "moviepilot",
		Image:          "jxxghp/moviepilot:latest",
		State:          "running",
		Running:        true,
		ComposeProject: "media",
		ComposeService: "moviepilot",
	}}

	merged := mergeDiscovered(cfg, discovered)
	if merged.Containers["new"].Name != "moviepilot" {
		t.Fatalf("expected discovered name stored, got %q", merged.Containers["new"].Name)
	}
	if merged.Containers["new"].ReadinessMode != readinessAuto {
		t.Fatalf("expected default readiness auto, got %q", merged.Containers["new"].ReadinessMode)
	}
	if merged.Containers["new"].Enabled {
		t.Fatal("newly discovered containers should not join startup orchestration by default")
	}
	if merged.Containers["new"].Monitor {
		t.Fatal("newly discovered containers should not join guard monitoring by default")
	}

	rows := withConfiguredEntries(merged, discovered)
	if len(rows) != 1 {
		t.Fatalf("expected stale entry to be pruned, got %d rows", len(rows))
	}
	if rows[0].Config.Name != "moviepilot" {
		t.Fatalf("expected discovered config attached, got %#v", rows[0].Config)
	}
	if _, ok := merged.Containers["stale"]; ok {
		t.Fatal("stale container config should be removed after discovery")
	}
}

func TestReadyModes(t *testing.T) {
	runningUnhealthy := Container{State: "running", Running: true, Health: "unhealthy"}
	if ready(runningUnhealthy, true, readinessAuto) {
		t.Fatal("auto readiness should reject unhealthy containers")
	}
	if !ready(runningUnhealthy, true, readinessRunning) {
		t.Fatal("running readiness should accept running containers")
	}
	if ready(runningUnhealthy, true, readinessHealthy) {
		t.Fatal("healthy readiness should reject unhealthy containers")
	}
}

func TestManagerContainerProtection(t *testing.T) {
	if !isManagerContainer("docker-manager-ui", "ym040923/docker-manager:latest") {
		t.Fatal("docker-manager container should be protected")
	}
	if isManagerContainer("moviepilot", "jxxghp/moviepilot:latest") {
		t.Fatal("unrelated container should not be protected")
	}
}

func TestOrderedMonitorOnlyUsesGuardedContainersOutsideStartupPlan(t *testing.T) {
	cfg := Config{
		Containers: map[string]ContainerConfig{
			"startupOnly": {
				Enabled:      true,
				Monitor:      false,
				StartupOrder: 1,
			},
			"guardOnly": {
				Enabled:      false,
				Monitor:      true,
				StartupOrder: 2,
				MonitorOrder: 1,
			},
			"unmanaged": {
				Enabled:      false,
				Monitor:      false,
				StartupOrder: 3,
			},
		},
	}

	items := ordered(cfg, true)
	if len(items) != 1 {
		t.Fatalf("expected one guarded item, got %d", len(items))
	}
	if items[0].ID != "guardOnly" {
		t.Fatalf("expected guardOnly, got %q", items[0].ID)
	}
}

func TestOrderedMonitorOnlyUsesGuardJoinOrder(t *testing.T) {
	cfg := Config{
		Containers: map[string]ContainerConfig{
			"firstGuard": {
				Monitor:      true,
				StartupOrder: 50,
				MonitorOrder: 10,
			},
			"secondGuard": {
				Monitor:      true,
				StartupOrder: 10,
				MonitorOrder: 20,
			},
		},
	}

	items := ordered(cfg, true)
	if len(items) != 2 {
		t.Fatalf("expected two guarded items, got %d", len(items))
	}
	if items[0].ID != "firstGuard" || items[1].ID != "secondGuard" {
		t.Fatalf("expected guard join order, got %q then %q", items[0].ID, items[1].ID)
	}
}

func TestServeStaticDisablesClientCaching(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte("console.log('ok')"), 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp(t.TempDir(), dir, "/var/run/docker.sock")
	req := httptest.NewRequest(http.MethodGet, gatewayPrefix+"/app.js", nil)
	rec := httptest.NewRecorder()

	app.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store, no-cache, must-revalidate" {
		t.Fatalf("expected no-store cache header, got %q", got)
	}
}

func TestClaimBootStartupRunsOnlyOnceForSameSystemBoot(t *testing.T) {
	dir := t.TempDir()
	bootIDPath := filepath.Join(dir, "boot_id")
	if err := os.WriteFile(bootIDPath, []byte("boot-one\n"), 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp(dir, t.TempDir(), "/var/run/docker.sock")
	app.bootIDPath = bootIDPath

	allowed, bootID, err := app.claimBootStartup()
	if err != nil {
		t.Fatal(err)
	}
	if !allowed || bootID != "boot-one" {
		t.Fatalf("expected first claim for boot-one to run, got allowed=%v bootID=%q", allowed, bootID)
	}

	allowed, bootID, err = app.claimBootStartup()
	if err != nil {
		t.Fatal(err)
	}
	if allowed || bootID != "boot-one" {
		t.Fatalf("expected second claim for same boot to be skipped, got allowed=%v bootID=%q", allowed, bootID)
	}
}

func TestClaimBootStartupRunsAgainAfterSystemBootChanges(t *testing.T) {
	dir := t.TempDir()
	bootIDPath := filepath.Join(dir, "boot_id")
	if err := os.WriteFile(bootIDPath, []byte("boot-one\n"), 0644); err != nil {
		t.Fatal(err)
	}
	app := NewApp(dir, t.TempDir(), "/var/run/docker.sock")
	app.bootIDPath = bootIDPath

	if allowed, _, err := app.claimBootStartup(); err != nil || !allowed {
		t.Fatalf("expected first claim to run, allowed=%v err=%v", allowed, err)
	}
	if err := os.WriteFile(bootIDPath, []byte("boot-two\n"), 0644); err != nil {
		t.Fatal(err)
	}

	allowed, bootID, err := app.claimBootStartup()
	if err != nil {
		t.Fatal(err)
	}
	if !allowed || bootID != "boot-two" {
		t.Fatalf("expected changed boot id to run, got allowed=%v bootID=%q", allowed, bootID)
	}
}

func TestWithinBootStartupWindowUsesSystemUptime(t *testing.T) {
	dir := t.TempDir()
	uptimePath := filepath.Join(dir, "uptime")
	app := NewApp(dir, t.TempDir(), "/var/run/docker.sock")
	app.uptimePath = uptimePath
	app.bootWindow = 30 * time.Minute

	if err := os.WriteFile(uptimePath, []byte("120.00 999.00\n"), 0644); err != nil {
		t.Fatal(err)
	}
	inWindow, err := app.withinBootStartupWindow()
	if err != nil {
		t.Fatal(err)
	}
	if !inWindow {
		t.Fatal("expected two-minute uptime to be inside boot startup window")
	}

	if err := os.WriteFile(uptimePath, []byte("7200.00 999.00\n"), 0644); err != nil {
		t.Fatal(err)
	}
	inWindow, err = app.withinBootStartupWindow()
	if err != nil {
		t.Fatal(err)
	}
	if inWindow {
		t.Fatal("expected two-hour uptime to be outside boot startup window")
	}
}
