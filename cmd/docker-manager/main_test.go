package main

import "testing"

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

	rows := withConfiguredEntries(merged, discovered)
	if len(rows) != 2 {
		t.Fatalf("expected discovered plus stale row, got %d", len(rows))
	}
	if !rows[0].Missing {
		t.Fatalf("expected stale entry first by order and marked missing, got %#v", rows[0])
	}
	if rows[1].Config.Name != "moviepilot" {
		t.Fatalf("expected discovered config attached, got %#v", rows[1].Config)
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
