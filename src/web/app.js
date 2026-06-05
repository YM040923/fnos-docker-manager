const state = {
  containers: [],
  config: null,
  monitor: null,
  logs: [],
  dockerError: "",
  loading: false,
  logsCollapsed: false,
  filters: {
    query: "",
    status: "all",
    monitoredOnly: false,
  },
};

const basePath = String(window.DOCKER_MANAGER_BASE || "/app/dockermanager").replace(/\/$/, "");
const $ = (id) => document.getElementById(id);

function route(path) {
  return `${basePath}/${String(path).replace(/^\.\//, "").replace(/^\//, "")}`;
}

function showAlert(message) {
  const el = $("alert");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok || json.error) {
    throw new Error(json.error?.message || `HTTP ${response.status}`);
  }
  return json;
}

async function loadContainers() {
  setLoading(true);
  try {
    const result = await api(route("api/containers"));
    state.containers = result.containers || [];
    state.config = result.config || defaultConfig();
    state.dockerError = "";
    showAlert("");
    render();
  } catch (error) {
    state.dockerError = error.message;
    showAlert(error.message);
    render();
  } finally {
    setLoading(false);
  }
}

async function loadMonitor() {
  try {
    state.monitor = await api(route("api/monitor"));
    renderMonitor();
  } catch (error) {
    state.monitor = { lastError: error.message };
    renderMonitor();
  }
}

async function loadLogs() {
  try {
    state.logs = await api(route("api/logs"));
  } catch (error) {
    state.logs = [{ time: "", message: error.message }];
  }
  renderLogs();
}

function render() {
  const rows = $("containerRows");
  const config = normalizedDraftConfig();
  const visibleContainers = filteredContainers(config);
  const badContainers = state.containers.filter((item) => item.state !== "running" || item.health === "unhealthy");

  $("dockerState").textContent = state.dockerError ? "不可用" : "正常";
  $("containerCount").textContent = String(state.containers.length);
  $("badCount").textContent = String(badContainers.length);
  $("lastRefresh").textContent = new Date().toLocaleTimeString();
  $("checkInterval").value = config.settings.checkIntervalSeconds || 60;
  $("retryDelay").value = config.settings.startupRetryDelaySeconds || 10;
  $("startupTimeout").value = config.settings.startupTimeoutSeconds || 120;
  $("emptyState").textContent = state.containers.length === 0 ? "没有发现容器。" : "没有符合条件的容器。";
  $("emptyState").classList.toggle("hidden", visibleContainers.length !== 0);

  rows.innerHTML = visibleContainers.map((container) => renderContainerRow(container, config)).join("");
  renderMonitor();
}

function renderMonitor() {
  const monitor = state.monitor || {};
  if (!$("monitorState") || !$("nextCheck")) return;

  if (monitor.running) {
    $("monitorState").textContent = "巡检中";
  } else if (monitor.lastError) {
    $("monitorState").textContent = "有异常";
  } else if (monitor.lastFinishedAt) {
    $("monitorState").textContent = "正常";
  } else {
    $("monitorState").textContent = "等待首次巡检";
  }

  $("nextCheck").textContent = monitor.nextCheckAt ? formatTime(monitor.nextCheckAt) : "-";
}

function renderLogs() {
  const logs = $("logs");
  const toggle = $("toggleLogsBtn");
  logs.classList.toggle("collapsed", state.logsCollapsed);
  if (toggle) toggle.textContent = state.logsCollapsed ? "展开" : "折叠";
  logs.innerHTML =
    state.logs.length === 0
      ? '<div class="empty">暂无日志。</div>'
      : state.logs
          .map(
            (item) => `<div class="log-item"><time>${escapeHtml(formatTime(item.time) || "")}</time>${escapeHtml(
              item.message || "",
            )}</div>`,
          )
          .join("");
}

function renderContainerRow(container, config) {
  const item = config.containers[container.id] || {};
  const statusClass = container.health === "unhealthy" ? "unhealthy" : container.state;
  return `<tr data-id="${escapeHtml(container.id)}">
    <td><input aria-label="${escapeHtml(container.name)} 的启动顺序" name="startupOrder" data-field="startupOrder" type="number" min="0" value="${numberValue(
      item.startupOrder,
      0,
    )}" /></td>
    <td>
      <span class="container-name" title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</span>
      <span class="container-id">${escapeHtml(container.id.slice(0, 12))}</span>
    </td>
    <td><span class="image-name" title="${escapeHtml(container.image)}">${escapeHtml(container.image)}</span></td>
    <td><span class="status ${escapeHtml(statusClass)}">${escapeHtml(statusText(container))}</span></td>
    <td><input aria-label="${escapeHtml(container.name)} 的启动延迟" name="startupDelaySeconds" data-field="startupDelaySeconds" type="number" min="0" value="${numberValue(
      item.startupDelaySeconds,
      0,
    )}" /></td>
    <td><input aria-label="监控 ${escapeHtml(container.name)}" name="monitor" data-field="monitor" type="checkbox" ${
      item.monitor !== false ? "checked" : ""
    } /></td>
    <td><div class="row-actions">
      <button type="button" class="icon-button" title="启动" aria-label="启动 ${escapeHtml(container.name)}" data-action="start">启</button>
      <button type="button" class="icon-button" title="重启" aria-label="重启 ${escapeHtml(container.name)}" data-action="restart">重</button>
      <button type="button" class="icon-button danger" title="停止" aria-label="停止 ${escapeHtml(container.name)}" data-action="stop">停</button>
    </div></td>
  </tr>`;
}

function statusText(container) {
  if (container.health === "unhealthy") return "异常";
  if (container.health === "healthy") return "健康";
  const normalized = String(container.state || "").toLowerCase();
  const map = {
    created: "已创建",
    dead: "失效",
    exited: "已停止",
    paused: "已暂停",
    restarting: "重启中",
    running: "运行中",
  };
  return map[normalized] || container.status || container.state || "未知";
}

function filteredContainers(config) {
  const query = state.filters.query.trim().toLowerCase();
  return state.containers.filter((container) => {
    const item = config.containers[container.id] || {};
    if (state.filters.monitoredOnly && item.monitor === false) return false;
    if (state.filters.status === "running" && (container.state !== "running" || container.health === "unhealthy")) {
      return false;
    }
    if (state.filters.status === "problem" && container.state === "running" && container.health !== "unhealthy") {
      return false;
    }
    if (state.filters.status === "stopped" && container.state === "running") {
      return false;
    }
    if (!query) return true;
    return [container.name, container.image, container.id, container.status]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
}

function defaultConfig() {
  return {
    version: 1,
    settings: {
      checkIntervalSeconds: 60,
      startupRetryDelaySeconds: 10,
      startupTimeoutSeconds: 120,
    },
    containers: {},
  };
}

function normalizedDraftConfig() {
  if (!state.config) state.config = defaultConfig();
  state.config.settings ||= defaultConfig().settings;
  state.config.containers ||= {};
  return state.config;
}

function syncSettingsToDraft() {
  const config = normalizedDraftConfig();
  config.settings = {
    checkIntervalSeconds: Number($("checkInterval").value),
    startupRetryDelaySeconds: Number($("retryDelay").value),
    startupTimeoutSeconds: Number($("startupTimeout").value),
  };
}

function syncRowToDraft(row) {
  if (!row) return;
  const id = row.dataset.id;
  const config = normalizedDraftConfig();
  config.containers[id] = {
    ...(config.containers[id] || {}),
    enabled: true,
    startupOrder: Number(row.querySelector('[data-field="startupOrder"]').value),
    startupDelaySeconds: Number(row.querySelector('[data-field="startupDelaySeconds"]').value),
    monitor: row.querySelector('[data-field="monitor"]').checked,
  };
}

function collectConfig() {
  syncSettingsToDraft();
  document.querySelectorAll("tbody tr[data-id]").forEach(syncRowToDraft);
  return normalizedDraftConfig();
}

async function saveConfig() {
  try {
    state.config = await api(route("api/config"), {
      method: "PUT",
      body: JSON.stringify(collectConfig()),
    });
    showAlert("配置已保存。");
    render();
  } catch (error) {
    showAlert(error.message);
  }
}

async function runAction(path) {
  setLoading(true);
  try {
    await api(path, { method: "POST" });
    await loadContainers();
    await loadMonitor();
    await loadLogs();
  } catch (error) {
    showAlert(error.message);
  } finally {
    setLoading(false);
  }
}

function setLoading(loading) {
  state.loading = loading;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = loading;
  });
}

function numberValue(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

$("refreshBtn").addEventListener("click", loadContainers);
$("saveBtn").addEventListener("click", saveConfig);
$("startupBtn").addEventListener("click", () => runAction(route("api/actions/startup-run")));
$("reloadLogsBtn").addEventListener("click", loadLogs);
$("toggleLogsBtn").addEventListener("click", () => {
  state.logsCollapsed = !state.logsCollapsed;
  renderLogs();
});
$("searchInput").addEventListener("input", (event) => {
  state.filters.query = event.target.value;
  render();
});
$("statusFilter").addEventListener("change", (event) => {
  state.filters.status = event.target.value;
  render();
});
$("monitoredOnly").addEventListener("change", (event) => {
  state.filters.monitoredOnly = event.target.checked;
  render();
});
$("containerRows").addEventListener("input", (event) => {
  if (event.target.matches("[data-field]")) syncRowToDraft(event.target.closest("tr[data-id]"));
});
$("containerRows").addEventListener("change", (event) => {
  if (event.target.matches("[data-field]")) syncRowToDraft(event.target.closest("tr[data-id]"));
});
$("containerRows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("tr[data-id]");
  runAction(route(`api/containers/${encodeURIComponent(row.dataset.id)}/${button.dataset.action}`));
});

await loadContainers();
await loadMonitor();
await loadLogs();
setInterval(loadMonitor, 15000);
