package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const gatewayPrefix = "/app/dockerstart"
const currentConfigVersion = 2

const (
	readinessAuto    = "auto"
	readinessRunning = "running"
	readinessHealthy = "healthy"
	policyRetry      = "retry"
	policyLog        = "log"
)

type Settings struct {
	CheckIntervalSeconds     int  `json:"checkIntervalSeconds"`
	StartupRetryDelaySeconds int  `json:"startupRetryDelaySeconds"`
	StartupTimeoutSeconds    int  `json:"startupTimeoutSeconds"`
	AutoRunOnStart           bool `json:"autoRunOnStart"`
	ProtectManagerContainers bool `json:"protectManagerContainers"`
	LogRetentionLines        int  `json:"logRetentionLines"`
}

type ContainerConfig struct {
	Enabled             bool   `json:"enabled"`
	Name                string `json:"name,omitempty"`
	Image               string `json:"image,omitempty"`
	StartupOrder        int    `json:"startupOrder"`
	StartupDelaySeconds int    `json:"startupDelaySeconds"`
	Monitor             bool   `json:"monitor"`
	MonitorOrder        int    `json:"monitorOrder,omitempty"`
	ReadinessMode       string `json:"readinessMode"`
	FailurePolicy       string `json:"failurePolicy"`
}

type Config struct {
	Version    int                        `json:"version"`
	Settings   Settings                   `json:"settings"`
	Containers map[string]ContainerConfig `json:"containers"`
}

type Container struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Image          string          `json:"image"`
	State          string          `json:"state"`
	Status         string          `json:"status"`
	Health         string          `json:"health"`
	Running        bool            `json:"running"`
	Missing        bool            `json:"missing"`
	Protected      bool            `json:"protected"`
	Created        int64           `json:"created,omitempty"`
	Ports          []PortSummary   `json:"ports,omitempty"`
	Mounts         []MountSummary  `json:"mounts,omitempty"`
	Networks       []NetworkInfo   `json:"networks,omitempty"`
	ComposeProject string          `json:"composeProject,omitempty"`
	ComposeService string          `json:"composeService,omitempty"`
	Config         ContainerConfig `json:"config"`
}

type PortSummary struct {
	IP          string `json:"ip,omitempty"`
	PrivatePort int    `json:"privatePort"`
	PublicPort  int    `json:"publicPort,omitempty"`
	Type        string `json:"type"`
}

type MountSummary struct {
	Type        string `json:"type"`
	Source      string `json:"source,omitempty"`
	Destination string `json:"destination"`
	Mode        string `json:"mode,omitempty"`
	RW          bool   `json:"rw"`
}

type NetworkInfo struct {
	Name      string `json:"name"`
	IPAddress string `json:"ipAddress,omitempty"`
}

type MonitorStatus struct {
	Running        bool           `json:"running"`
	LastStartedAt  string         `json:"lastStartedAt"`
	LastFinishedAt string         `json:"lastFinishedAt"`
	NextCheckAt    string         `json:"nextCheckAt"`
	LastError      string         `json:"lastError"`
	LastResult     map[string]any `json:"lastResult,omitempty"`
}

type App struct {
	dataDir       string
	webDir        string
	dockerSock    string
	configPath    string
	logPath       string
	client        *http.Client
	mu            sync.Mutex
	runMu         sync.Mutex
	monitorMu     sync.Mutex
	monitorStatus MonitorStatus
	bootIDPath    string
	uptimePath    string
	bootWindow    time.Duration
}

func main() {
	appDest := getenv("TRIM_APPDEST", ".")
	dataDir := getenv("TRIM_PKGVAR", filepath.Join(appDest, "var"))
	socketPath := getenv("FNOS_SOCKET_PATH", filepath.Join(appDest, "app.sock"))
	webDir := getenv("FNOS_WEB_DIR", filepath.Join(appDest, "web"))

	app := NewApp(dataDir, webDir, getenv("DOCKER_SOCKET", "/var/run/docker.sock"))
	app.startBootStartupOnce()
	app.startMonitorLoop()
	_ = os.Remove(socketPath)
	if err := os.MkdirAll(filepath.Dir(socketPath), 0755); err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatal(err)
	}
	_ = os.Chmod(socketPath, 0660)
	log.Printf("Docker Manager listening on %s", socketPath)
	if err := http.Serve(listener, app.routes()); err != nil {
		log.Fatal(err)
	}
}

func NewApp(dataDir, webDir, dockerSock string) *App {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", dockerSock)
		},
	}
	return &App{
		dataDir:    dataDir,
		webDir:     webDir,
		dockerSock: dockerSock,
		configPath: filepath.Join(dataDir, "config.json"),
		logPath:    filepath.Join(dataDir, "logs", "activity.log"),
		client:     &http.Client{Transport: transport, Timeout: 15 * time.Second},
		bootIDPath: "/proc/sys/kernel/random/boot_id",
		uptimePath: "/proc/uptime",
		bootWindow: 30 * time.Minute,
	}
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.handle)
	return mux
}

func (a *App) handle(w http.ResponseWriter, r *http.Request) {
	pathName := strings.TrimPrefix(r.URL.Path, gatewayPrefix)
	if pathName == "" {
		pathName = "/"
	}
	if strings.HasPrefix(pathName, "/api/") {
		a.handleAPI(w, r, pathName)
		return
	}
	a.serveStatic(w, r, pathName)
}

func (a *App) handleAPI(w http.ResponseWriter, r *http.Request, pathName string) {
	switch {
	case r.Method == http.MethodGet && pathName == "/api/health":
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case r.Method == http.MethodGet && pathName == "/api/config":
		cfg, err := a.readConfig()
		writeResult(w, cfg, err)
	case r.Method == http.MethodPut && pathName == "/api/config":
		var cfg Config
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_JSON", err.Error())
			return
		}
		saved, err := a.writeConfig(normalizeConfig(cfg))
		if err == nil {
			_ = a.appendLog("config", "Configuration saved", nil)
		}
		writeResult(w, saved, err)
	case r.Method == http.MethodGet && pathName == "/api/containers":
		a.handleContainers(w)
	case r.Method == http.MethodPost && pathName == "/api/actions/refresh":
		a.handleRefresh(w)
	case r.Method == http.MethodPost && pathName == "/api/actions/startup-run":
		cfg, err := a.readConfig()
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		writeResult(w, a.runOrderedStartup(cfg, false, "manual"), nil)
	case r.Method == http.MethodGet && pathName == "/api/monitor":
		writeResult(w, a.currentMonitorStatus(), nil)
	case r.Method == http.MethodGet && pathName == "/api/logs":
		writeResult(w, a.readLogs(), nil)
	case r.Method == http.MethodPost && pathName == "/api/logs/clear":
		writeResult(w, map[string]bool{"ok": true}, a.clearLogs())
	default:
		if strings.HasPrefix(pathName, "/api/containers/") && r.Method == http.MethodGet {
			a.handleContainerDetails(w, pathName)
			return
		}
		if strings.HasPrefix(pathName, "/api/containers/") && r.Method == http.MethodPost {
			a.handleContainerAction(w, pathName)
			return
		}
		writeError(w, http.StatusNotFound, "NOT_FOUND", "API route not found")
	}
}

func (a *App) handleContainers(w http.ResponseWriter) {
	cfg, err := a.readConfig()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	containers, err := a.listContainers()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	cfg = mergeDiscovered(cfg, containers)
	_, _ = a.writeConfig(cfg)
	containers = withConfiguredEntries(cfg, containers)
	writeJSON(w, http.StatusOK, map[string]any{"containers": containers, "config": cfg})
}

func (a *App) handleRefresh(w http.ResponseWriter) {
	a.handleContainers(w)
	_ = a.appendLog("refresh", "Container discovery refreshed", nil)
}

func (a *App) handleContainerAction(w http.ResponseWriter, pathName string) {
	parts := strings.Split(strings.TrimPrefix(pathName, "/api/containers/"), "/")
	if len(parts) != 2 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Container action not found")
		return
	}
	id, action := parts[0], parts[1]
	var err error
	switch action {
	case "start":
		err = a.docker("POST", "/containers/"+id+"/start", nil, nil)
	case "stop":
		err = a.docker("POST", "/containers/"+id+"/stop", nil, nil)
	case "restart":
		err = a.docker("POST", "/containers/"+id+"/restart", nil, nil)
	default:
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown action")
		return
	}
	if action == "stop" || action == "restart" {
		cfg, _ := a.readConfig()
		container, _, inspectErr := a.inspect(id)
		if inspectErr == nil && cfg.Settings.ProtectManagerContainers && isManagerContainer(container.Name, container.Image) {
			writeError(w, http.StatusForbidden, "PROTECTED_CONTAINER", "This container is protected by Docker Manager")
			return
		}
	}
	if err == nil {
		_ = a.appendLog(action, action+" requested", map[string]string{"id": id})
	}
	writeResult(w, map[string]bool{"ok": true}, err)
}

func (a *App) handleContainerDetails(w http.ResponseWriter, pathName string) {
	parts := strings.Split(strings.TrimPrefix(pathName, "/api/containers/"), "/")
	if len(parts) != 2 || parts[1] != "details" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Container detail route not found")
		return
	}
	container, _, err := a.inspect(parts[0])
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	cfg, _ := a.readConfig()
	if item, ok := cfg.Containers[container.ID]; ok {
		container.Config = item
	}
	container.Protected = cfg.Settings.ProtectManagerContainers && isManagerContainer(container.Name, container.Image)
	writeJSON(w, http.StatusOK, container)
}

func (a *App) listContainers() ([]Container, error) {
	var raw []struct {
		ID      string            `json:"Id"`
		Names   []string          `json:"Names"`
		Image   string            `json:"Image"`
		State   string            `json:"State"`
		Status  string            `json:"Status"`
		Created int64             `json:"Created"`
		Labels  map[string]string `json:"Labels"`
		Ports   []struct {
			IP          string `json:"IP"`
			PrivatePort int    `json:"PrivatePort"`
			PublicPort  int    `json:"PublicPort"`
			Type        string `json:"Type"`
		} `json:"Ports"`
		Mounts []struct {
			Type        string `json:"Type"`
			Source      string `json:"Source"`
			Destination string `json:"Destination"`
			Mode        string `json:"Mode"`
			RW          bool   `json:"RW"`
		} `json:"Mounts"`
		NetworkSettings struct {
			Networks map[string]struct {
				IPAddress string `json:"IPAddress"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
	}
	if err := a.docker("GET", "/containers/json?all=1", nil, &raw); err != nil {
		return nil, err
	}
	out := make([]Container, 0, len(raw))
	for _, row := range raw {
		name := row.ID
		if len(row.Names) > 0 {
			name = strings.TrimPrefix(row.Names[0], "/")
		}
		ports := []PortSummary{}
		for _, port := range row.Ports {
			ports = append(ports, PortSummary{IP: port.IP, PrivatePort: port.PrivatePort, PublicPort: port.PublicPort, Type: port.Type})
		}
		mounts := []MountSummary{}
		for _, mount := range row.Mounts {
			mounts = append(mounts, MountSummary{Type: mount.Type, Source: mount.Source, Destination: mount.Destination, Mode: mount.Mode, RW: mount.RW})
		}
		networks := []NetworkInfo{}
		for network, info := range row.NetworkSettings.Networks {
			networks = append(networks, NetworkInfo{Name: network, IPAddress: info.IPAddress})
		}
		sort.Slice(networks, func(i, j int) bool { return networks[i].Name < networks[j].Name })
		health := healthFromStatus(row.Status)
		out = append(out, Container{
			ID:             row.ID,
			Name:           name,
			Image:          row.Image,
			State:          row.State,
			Status:         row.Status,
			Health:         health,
			Running:        row.State == "running",
			Protected:      isManagerContainer(name, row.Image),
			Created:        row.Created,
			Ports:          ports,
			Mounts:         mounts,
			Networks:       networks,
			ComposeProject: row.Labels["com.docker.compose.project"],
			ComposeService: row.Labels["com.docker.compose.service"],
		})
	}
	return out, nil
}

func (a *App) inspect(id string) (Container, bool, error) {
	var raw struct {
		ID      string         `json:"Id"`
		Name    string         `json:"Name"`
		Created string         `json:"Created"`
		Mounts  []MountSummary `json:"Mounts"`
		Config  struct {
			Image  string            `json:"Image"`
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
		NetworkSettings struct {
			Networks map[string]struct {
				IPAddress string `json:"IPAddress"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
		State struct {
			Status  string `json:"Status"`
			Running bool   `json:"Running"`
			Health  *struct {
				Status string `json:"Status"`
			} `json:"Health"`
		} `json:"State"`
	}
	if err := a.docker("GET", "/containers/"+id+"/json", nil, &raw); err != nil {
		return Container{}, false, err
	}
	health := "none"
	if raw.State.Health != nil {
		health = raw.State.Health.Status
	}
	created := int64(0)
	if raw.Created != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, raw.Created); err == nil {
			created = parsed.Unix()
		}
	}
	networks := []NetworkInfo{}
	for network, info := range raw.NetworkSettings.Networks {
		networks = append(networks, NetworkInfo{Name: network, IPAddress: info.IPAddress})
	}
	sort.Slice(networks, func(i, j int) bool { return networks[i].Name < networks[j].Name })
	name := strings.TrimPrefix(raw.Name, "/")
	return Container{
		ID:             raw.ID,
		Name:           name,
		Image:          raw.Config.Image,
		State:          raw.State.Status,
		Status:         raw.State.Status,
		Health:         health,
		Running:        raw.State.Running,
		Protected:      isManagerContainer(name, raw.Config.Image),
		Created:        created,
		Mounts:         raw.Mounts,
		Networks:       networks,
		ComposeProject: raw.Config.Labels["com.docker.compose.project"],
		ComposeService: raw.Config.Labels["com.docker.compose.service"],
	}, raw.State.Running, nil
}

func (a *App) docker(method, pathName string, body any, target any) error {
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, "http://docker"+pathName, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot access %s: %w", a.dockerSock, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("docker API HTTP %d: %s", resp.StatusCode, string(data))
	}
	if target != nil && len(data) > 0 {
		return json.Unmarshal(data, target)
	}
	return nil
}

func (a *App) startMonitorLoop() {
	go func() {
		firstRun := true
		for {
			cfg, err := a.readConfig()
			if err != nil {
				next := time.Now().Add(time.Minute)
				a.setMonitorStatus(func(status *MonitorStatus) {
					status.Running = false
					status.LastError = err.Error()
					status.NextCheckAt = next.Format(time.RFC3339)
				})
				_ = a.appendLog("error", "Monitor config read failed", map[string]string{"error": err.Error()})
				time.Sleep(time.Until(next))
				continue
			}
			if firstRun {
				firstRun = false
				next := time.Now().Add(time.Duration(cfg.Settings.CheckIntervalSeconds) * time.Second)
				a.setMonitorStatus(func(status *MonitorStatus) {
					status.Running = false
					status.NextCheckAt = next.Format(time.RFC3339)
				})
				time.Sleep(time.Until(next))
				continue
			}

			started := time.Now()
			a.setMonitorStatus(func(status *MonitorStatus) {
				status.Running = true
				status.LastStartedAt = started.Format(time.RFC3339)
				status.LastError = ""
				status.NextCheckAt = ""
			})
			result := a.runOrderedStartup(cfg, true, "monitor")
			finished := time.Now()
			next := finished.Add(time.Duration(cfg.Settings.CheckIntervalSeconds) * time.Second)
			a.setMonitorStatus(func(status *MonitorStatus) {
				status.Running = false
				status.LastFinishedAt = finished.Format(time.RFC3339)
				status.NextCheckAt = next.Format(time.RFC3339)
				status.LastResult = result
				status.LastError = resultError(result)
			})
			time.Sleep(time.Until(next))
		}
	}()
}

func (a *App) startBootStartupOnce() {
	go func() {
		cfg, err := a.readConfig()
		if err != nil {
			_ = a.appendLog("error", "Boot startup config read failed", map[string]string{"error": err.Error()})
			return
		}
		if !cfg.Settings.AutoRunOnStart {
			_ = a.appendLog("startup", "Boot startup skipped by setting", nil)
			return
		}
		inWindow, err := a.withinBootStartupWindow()
		if err != nil {
			_ = a.appendLog("error", "Boot startup uptime check failed", map[string]string{"error": err.Error()})
			return
		}
		if !inWindow {
			_ = a.appendLog("startup", "Boot startup skipped outside system boot window", nil)
			return
		}
		if err := a.waitForDocker(cfg.Settings.StartupTimeoutSeconds); err != nil {
			_ = a.appendLog("error", "Boot startup Docker wait failed", map[string]string{"error": err.Error()})
			return
		}
		allowed, bootID, err := a.claimBootStartup()
		if err != nil {
			_ = a.appendLog("error", "Boot startup claim failed", map[string]string{"error": err.Error()})
			return
		}
		if !allowed {
			_ = a.appendLog("startup", "Boot startup already ran for this system boot", map[string]string{"bootID": bootID})
			return
		}

		started := time.Now()
		a.setMonitorStatus(func(status *MonitorStatus) {
			status.Running = true
			status.LastStartedAt = started.Format(time.RFC3339)
			status.LastError = ""
			status.NextCheckAt = ""
		})
		result := a.runOrderedStartup(cfg, false, "boot")
		finished := time.Now()
		a.setMonitorStatus(func(status *MonitorStatus) {
			status.Running = false
			status.LastFinishedAt = finished.Format(time.RFC3339)
			status.LastResult = result
			status.LastError = resultError(result)
		})
	}()
}

func (a *App) waitForDocker(timeoutSeconds int) error {
	deadline := time.Now().Add(time.Duration(clamp(timeoutSeconds, 120, 15, 3600)) * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		if err := a.docker("GET", "/_ping", nil, nil); err == nil {
			return nil
		} else {
			lastErr = err
		}
		time.Sleep(2 * time.Second)
	}
	if lastErr != nil {
		return lastErr
	}
	return errors.New("docker did not become ready before timeout")
}

func (a *App) withinBootStartupWindow() (bool, error) {
	if a.bootWindow <= 0 {
		return true, nil
	}
	data, err := os.ReadFile(a.uptimePath)
	if err != nil {
		return false, err
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return false, errors.New("empty system uptime")
	}
	uptimeSeconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return false, err
	}
	return time.Duration(uptimeSeconds*float64(time.Second)) <= a.bootWindow, nil
}

func (a *App) bootMarkerPath() string {
	return filepath.Join(a.dataDir, "run", "last_boot_startup.id")
}

func (a *App) currentBootID() (string, error) {
	data, err := os.ReadFile(a.bootIDPath)
	if err != nil {
		return "", err
	}
	bootID := strings.TrimSpace(string(data))
	if bootID == "" {
		return "", errors.New("empty system boot id")
	}
	return bootID, nil
}

func (a *App) claimBootStartup() (bool, string, error) {
	bootID, err := a.currentBootID()
	if err != nil {
		return false, "", err
	}
	markerPath := a.bootMarkerPath()
	if data, err := os.ReadFile(markerPath); err == nil && strings.TrimSpace(string(data)) == bootID {
		return false, bootID, nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, bootID, err
	}
	if err := os.MkdirAll(filepath.Dir(markerPath), 0755); err != nil {
		return false, bootID, err
	}
	if err := os.WriteFile(markerPath, []byte(bootID+"\n"), 0644); err != nil {
		return false, bootID, err
	}
	return true, bootID, nil
}

func (a *App) currentMonitorStatus() MonitorStatus {
	a.monitorMu.Lock()
	defer a.monitorMu.Unlock()
	return a.monitorStatus
}

func (a *App) setMonitorStatus(update func(*MonitorStatus)) {
	a.monitorMu.Lock()
	defer a.monitorMu.Unlock()
	update(&a.monitorStatus)
}

func (a *App) runOrderedStartup(cfg Config, monitorOnly bool, source string) map[string]any {
	a.runMu.Lock()
	defer a.runMu.Unlock()
	started := time.Now()
	items := ordered(cfg, monitorOnly)
	results := []map[string]any{}
	_ = a.appendLog("startup", "Ordered check started", map[string]string{"source": source, "count": strconv.Itoa(len(items))})
	for _, item := range items {
		result := a.ensureReady(item.ID, item.Config, cfg.Settings)
		results = append(results, result)
		if result["status"] != "ready" {
			break
		}
		if item.Config.StartupDelaySeconds > 0 {
			time.Sleep(time.Duration(item.Config.StartupDelaySeconds) * time.Second)
		}
	}
	finished := time.Now()
	_ = a.appendLog("startup", "Ordered check finished", map[string]string{"source": source, "count": strconv.Itoa(len(results))})
	return map[string]any{
		"status":     "ok",
		"source":     source,
		"startedAt":  started.Format(time.RFC3339),
		"finishedAt": finished.Format(time.RFC3339),
		"results":    results,
	}
}

func (a *App) ensureReady(id string, cfg ContainerConfig, settings Settings) map[string]any {
	deadline := time.Now().Add(time.Duration(settings.StartupTimeoutSeconds) * time.Second)
	attempts := 0
	for time.Now().Before(deadline) || attempts == 0 {
		attempts++
		container, running, err := a.inspect(id)
		if err != nil {
			_ = a.appendLog("error", "Inspect failed", map[string]string{"id": id, "error": err.Error()})
			if strings.Contains(err.Error(), "HTTP 404") {
				return map[string]any{"id": id, "name": cfg.Name, "status": "missing", "attempts": attempts, "error": err.Error()}
			}
			return map[string]any{"id": id, "name": cfg.Name, "status": "error", "attempts": attempts, "error": err.Error()}
		}
		if ready(container, running, cfg.ReadinessMode) {
			_ = a.appendLog("status_check", container.Name+" is ready", nil)
			return map[string]any{"id": id, "name": container.Name, "status": "ready", "attempts": attempts}
		}
		if !running {
			_ = a.appendLog("startup", "Starting "+container.Name, nil)
			if err := a.docker("POST", "/containers/"+id+"/start", nil, nil); err != nil {
				_ = a.appendLog("error", "Start failed", map[string]string{"id": id, "error": err.Error()})
				return map[string]any{"id": id, "name": container.Name, "status": "error", "attempts": attempts, "error": err.Error()}
			}
		} else if container.Health != "" && container.Health != "none" && container.Health != "healthy" {
			if cfg.FailurePolicy == policyLog {
				_ = a.appendLog("error", "Unhealthy "+container.Name+" requires manual action", map[string]string{"id": id, "health": container.Health})
				return map[string]any{"id": id, "name": container.Name, "status": "blocked", "attempts": attempts, "error": "unhealthy and policy is log"}
			}
			_ = a.appendLog("restart", "Restarting unhealthy "+container.Name, nil)
			if err := a.docker("POST", "/containers/"+id+"/restart", nil, nil); err != nil {
				_ = a.appendLog("error", "Restart failed", map[string]string{"id": id, "error": err.Error()})
				return map[string]any{"id": id, "name": container.Name, "status": "error", "attempts": attempts, "error": err.Error()}
			}
		}
		time.Sleep(time.Duration(settings.StartupRetryDelaySeconds) * time.Second)
	}
	return map[string]any{"id": id, "status": "timeout", "attempts": attempts}
}

func healthFromStatus(status string) string {
	switch {
	case strings.Contains(status, "(healthy)"):
		return "healthy"
	case strings.Contains(status, "(unhealthy)"):
		return "unhealthy"
	default:
		return "none"
	}
}

func resultError(result map[string]any) string {
	rows, ok := result["results"].([]map[string]any)
	if !ok {
		return ""
	}
	for _, row := range rows {
		if fmt.Sprint(row["status"]) != "ready" {
			if errText := fmt.Sprint(row["error"]); errText != "" && errText != "<nil>" {
				return errText
			}
			return fmt.Sprintf("%s: %s", row["id"], row["status"])
		}
	}
	return ""
}

func ready(container Container, running bool, mode string) bool {
	if !running && container.State != "running" {
		return false
	}
	switch normalizeReadinessMode(mode) {
	case readinessRunning:
		return running || container.State == "running"
	case readinessHealthy:
		return container.Health == "healthy"
	}
	if container.Health != "" && container.Health != "none" {
		return container.Health == "healthy"
	}
	return true
}

type orderedItem struct {
	ID     string
	Config ContainerConfig
}

func ordered(cfg Config, monitorOnly bool) []orderedItem {
	items := []orderedItem{}
	for id, item := range cfg.Containers {
		if monitorOnly {
			if !item.Monitor {
				continue
			}
		} else if !item.Enabled {
			continue
		}
		items = append(items, orderedItem{ID: id, Config: item})
	}
	sort.Slice(items, func(i, j int) bool {
		leftOrder := items[i].Config.StartupOrder
		rightOrder := items[j].Config.StartupOrder
		if monitorOnly {
			leftOrder = monitorOrder(items[i].Config)
			rightOrder = monitorOrder(items[j].Config)
		}
		if leftOrder != rightOrder {
			return leftOrder < rightOrder
		}
		return items[i].ID < items[j].ID
	})
	return items
}

func monitorOrder(item ContainerConfig) int {
	if item.MonitorOrder != 0 {
		return item.MonitorOrder
	}
	return item.StartupOrder
}

func (a *App) readConfig() (Config, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	data, err := os.ReadFile(a.configPath)
	if errors.Is(err, os.ErrNotExist) {
		cfg := normalizeConfig(Config{})
		return cfg, a.writeConfigLocked(cfg)
	}
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		cfg = normalizeConfig(Config{})
		return cfg, a.writeConfigLocked(cfg)
	}
	return normalizeConfig(cfg), nil
}

func (a *App) writeConfig(cfg Config) (Config, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg = normalizeConfig(cfg)
	return cfg, a.writeConfigLocked(cfg)
}

func (a *App) writeConfigLocked(cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(a.configPath), 0755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(a.configPath, append(data, '\n'), 0644)
}

func normalizeConfig(cfg Config) Config {
	isLegacy := cfg.Version < currentConfigVersion
	out := Config{
		Version: currentConfigVersion,
		Settings: Settings{
			CheckIntervalSeconds:     clamp(cfg.Settings.CheckIntervalSeconds, 60, 10, 3600),
			StartupRetryDelaySeconds: clamp(cfg.Settings.StartupRetryDelaySeconds, 10, 3, 600),
			StartupTimeoutSeconds:    clamp(cfg.Settings.StartupTimeoutSeconds, 120, 15, 3600),
			AutoRunOnStart:           cfg.Settings.AutoRunOnStart,
			ProtectManagerContainers: cfg.Settings.ProtectManagerContainers,
			LogRetentionLines:        clamp(cfg.Settings.LogRetentionLines, 500, 100, 5000),
		},
		Containers: map[string]ContainerConfig{},
	}
	if isLegacy {
		out.Settings.AutoRunOnStart = true
		out.Settings.ProtectManagerContainers = true
	}
	for id, item := range cfg.Containers {
		if id == "" {
			continue
		}
		itemMonitorOrder := item.MonitorOrder
		if itemMonitorOrder == 0 {
			itemMonitorOrder = item.StartupOrder
		}
		out.Containers[id] = ContainerConfig{
			Enabled:             item.Enabled,
			Name:                item.Name,
			Image:               item.Image,
			StartupOrder:        clamp(item.StartupOrder, 0, 0, 999999),
			StartupDelaySeconds: clamp(item.StartupDelaySeconds, 0, 0, 3600),
			Monitor:             item.Monitor,
			MonitorOrder:        clamp(itemMonitorOrder, 0, 0, 999999),
			ReadinessMode:       normalizeReadinessMode(item.ReadinessMode),
			FailurePolicy:       normalizeFailurePolicy(item.FailurePolicy),
		}
		if !item.Enabled {
			normalized := out.Containers[id]
			normalized.Enabled = false
			out.Containers[id] = normalized
		}
	}
	return out
}

func mergeDiscovered(cfg Config, containers []Container) Config {
	cfg = normalizeConfig(cfg)
	discovered := map[string]bool{}
	for _, container := range containers {
		discovered[container.ID] = true
	}

	maxStartupOrder := 0
	maxMonitorOrder := 0
	for id, item := range cfg.Containers {
		if !discovered[id] {
			continue
		}
		if item.StartupOrder > maxStartupOrder {
			maxStartupOrder = item.StartupOrder
		}
		if monitorOrder(item) > maxMonitorOrder {
			maxMonitorOrder = monitorOrder(item)
		}
	}

	next := map[string]ContainerConfig{}
	for _, container := range containers {
		item, ok := cfg.Containers[container.ID]
		if !ok {
			maxStartupOrder += 10
			maxMonitorOrder += 10
			next[container.ID] = ContainerConfig{
				Enabled:             false,
				Name:                container.Name,
				Image:               container.Image,
				StartupOrder:        maxStartupOrder,
				StartupDelaySeconds: 0,
				Monitor:             false,
				MonitorOrder:        maxMonitorOrder,
				ReadinessMode:       readinessAuto,
				FailurePolicy:       policyRetry,
			}
			continue
		}
		item.Name = container.Name
		item.Image = container.Image
		if item.MonitorOrder == 0 {
			item.MonitorOrder = item.StartupOrder
		}
		item.ReadinessMode = normalizeReadinessMode(item.ReadinessMode)
		item.FailurePolicy = normalizeFailurePolicy(item.FailurePolicy)
		next[container.ID] = item
	}
	cfg.Containers = next
	return cfg
}

func withConfiguredEntries(cfg Config, containers []Container) []Container {
	out := make([]Container, 0, len(containers))
	for _, container := range containers {
		item := cfg.Containers[container.ID]
		container.Config = item
		container.Protected = cfg.Settings.ProtectManagerContainers && isManagerContainer(container.Name, container.Image)
		out = append(out, container)
	}
	sort.SliceStable(out, func(i, j int) bool {
		left := out[i].Config.StartupOrder
		right := out[j].Config.StartupOrder
		if left != right {
			return left < right
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func normalizeReadinessMode(value string) string {
	switch value {
	case readinessRunning, readinessHealthy:
		return value
	default:
		return readinessAuto
	}
}

func normalizeFailurePolicy(value string) string {
	switch value {
	case policyLog:
		return value
	default:
		return policyRetry
	}
}

func isManagerContainer(name, image string) bool {
	text := strings.ToLower(name + " " + image)
	return strings.Contains(text, "dockerstart") || strings.Contains(text, "docker-manager") || strings.Contains(text, "fnos-docker-manager")
}

func clamp(value, fallback, min, max int) int {
	if value == 0 {
		value = fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func (a *App) appendLog(kind, message string, data map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(a.logPath), 0755); err != nil {
		return err
	}
	row := map[string]any{"time": time.Now().Format(time.RFC3339), "type": kind, "message": message, "data": data}
	encoded, _ := json.Marshal(row)
	file, err := os.OpenFile(a.logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err = file.Write(append(encoded, '\n')); err != nil {
		return err
	}
	return a.trimLogs(500)
}

func (a *App) readLogs() []map[string]any {
	data, err := os.ReadFile(a.logPath)
	if err != nil {
		return []map[string]any{}
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	out := []map[string]any{}
	for i := len(lines) - 1; i >= 0 && len(out) < 200; i-- {
		var row map[string]any
		if json.Unmarshal([]byte(lines[i]), &row) == nil {
			out = append(out, row)
		}
	}
	return out
}

func (a *App) clearLogs() error {
	if err := os.MkdirAll(filepath.Dir(a.logPath), 0755); err != nil {
		return err
	}
	return os.WriteFile(a.logPath, nil, 0644)
}

func (a *App) trimLogs(limit int) error {
	if limit <= 0 {
		return nil
	}
	data, err := os.ReadFile(a.logPath)
	if err != nil {
		return nil
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return nil
	}
	lines := strings.Split(text, "\n")
	if len(lines) <= limit {
		return nil
	}
	lines = lines[len(lines)-limit:]
	return os.WriteFile(a.logPath, []byte(strings.Join(lines, "\n")+"\n"), 0644)
}

func (a *App) serveStatic(w http.ResponseWriter, r *http.Request, pathName string) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	if pathName == "/" {
		pathName = "/index.html"
	}
	target := filepath.Clean(filepath.Join(a.webDir, pathName))
	base := filepath.Clean(a.webDir)
	if !strings.HasPrefix(target, base) {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(target); err != nil {
		target = filepath.Join(a.webDir, "index.html")
	}
	http.ServeFile(w, r, target)
}

func writeResult(w http.ResponseWriter, value any, err error) {
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func atoi(value string, fallback int) int {
	number, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return number
}
