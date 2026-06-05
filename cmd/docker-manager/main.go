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

const gatewayPrefix = "/app/dockermanager"

type Settings struct {
	CheckIntervalSeconds     int `json:"checkIntervalSeconds"`
	StartupRetryDelaySeconds int `json:"startupRetryDelaySeconds"`
	StartupTimeoutSeconds    int `json:"startupTimeoutSeconds"`
}

type ContainerConfig struct {
	Enabled             bool `json:"enabled"`
	StartupOrder        int  `json:"startupOrder"`
	StartupDelaySeconds int  `json:"startupDelaySeconds"`
	Monitor             bool `json:"monitor"`
}

type Config struct {
	Version    int                        `json:"version"`
	Settings   Settings                   `json:"settings"`
	Containers map[string]ContainerConfig `json:"containers"`
}

type Container struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
	State  string `json:"state"`
	Status string `json:"status"`
	Health string `json:"health"`
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
}

func main() {
	appDest := getenv("TRIM_APPDEST", ".")
	dataDir := getenv("TRIM_PKGVAR", filepath.Join(appDest, "var"))
	socketPath := getenv("FNOS_SOCKET_PATH", filepath.Join(appDest, "app.sock"))
	webDir := getenv("FNOS_WEB_DIR", filepath.Join(appDest, "web"))

	app := NewApp(dataDir, webDir, getenv("DOCKER_SOCKET", "/var/run/docker.sock"))
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
	default:
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
	if err == nil {
		_ = a.appendLog(action, action+" requested", map[string]string{"id": id})
	}
	writeResult(w, map[string]bool{"ok": true}, err)
}

func (a *App) listContainers() ([]Container, error) {
	var raw []struct {
		ID     string   `json:"Id"`
		Names  []string `json:"Names"`
		Image  string   `json:"Image"`
		State  string   `json:"State"`
		Status string   `json:"Status"`
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
		out = append(out, Container{ID: row.ID, Name: name, Image: row.Image, State: row.State, Status: row.Status, Health: healthFromStatus(row.Status)})
	}
	return out, nil
}

func (a *App) inspect(id string) (Container, bool, error) {
	var raw struct {
		ID     string `json:"Id"`
		Name   string `json:"Name"`
		Config struct {
			Image string `json:"Image"`
		} `json:"Config"`
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
	return Container{ID: raw.ID, Name: strings.TrimPrefix(raw.Name, "/"), Image: raw.Config.Image, State: raw.State.Status, Status: raw.State.Status, Health: health}, raw.State.Running, nil
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
			return map[string]any{"id": id, "status": "error", "attempts": attempts, "error": err.Error()}
		}
		if ready(container, running) {
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

func ready(container Container, running bool) bool {
	if !running && container.State != "running" {
		return false
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
		if !item.Enabled || (monitorOnly && !item.Monitor) {
			continue
		}
		items = append(items, orderedItem{ID: id, Config: item})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Config.StartupOrder != items[j].Config.StartupOrder {
			return items[i].Config.StartupOrder < items[j].Config.StartupOrder
		}
		return items[i].ID < items[j].ID
	})
	return items
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
	out := Config{
		Version: 1,
		Settings: Settings{
			CheckIntervalSeconds:     clamp(cfg.Settings.CheckIntervalSeconds, 60, 10, 3600),
			StartupRetryDelaySeconds: clamp(cfg.Settings.StartupRetryDelaySeconds, 10, 3, 600),
			StartupTimeoutSeconds:    clamp(cfg.Settings.StartupTimeoutSeconds, 120, 15, 3600),
		},
		Containers: map[string]ContainerConfig{},
	}
	for id, item := range cfg.Containers {
		if id == "" {
			continue
		}
		out.Containers[id] = ContainerConfig{
			Enabled:             item.Enabled,
			StartupOrder:        clamp(item.StartupOrder, 0, 0, 999999),
			StartupDelaySeconds: clamp(item.StartupDelaySeconds, 0, 0, 3600),
			Monitor:             item.Monitor,
		}
		if !item.Enabled {
			out.Containers[id] = ContainerConfig{Enabled: false, StartupOrder: out.Containers[id].StartupOrder, StartupDelaySeconds: out.Containers[id].StartupDelaySeconds, Monitor: item.Monitor}
		}
	}
	return out
}

func mergeDiscovered(cfg Config, containers []Container) Config {
	cfg = normalizeConfig(cfg)
	maxOrder := 0
	for _, item := range cfg.Containers {
		if item.StartupOrder > maxOrder {
			maxOrder = item.StartupOrder
		}
	}
	for _, container := range containers {
		if _, ok := cfg.Containers[container.ID]; !ok {
			maxOrder += 10
			cfg.Containers[container.ID] = ContainerConfig{Enabled: true, StartupOrder: maxOrder, StartupDelaySeconds: 0, Monitor: true}
		}
	}
	return cfg
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
	_, err = file.Write(append(encoded, '\n'))
	return err
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

func (a *App) serveStatic(w http.ResponseWriter, r *http.Request, pathName string) {
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
