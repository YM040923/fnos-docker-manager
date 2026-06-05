const pageMeta = {
  dashboard: ["控制台", "查看 Docker 守护状态、异常容器和最近事件。"],
  plan: ["启动编排", "编辑容器启动顺序、就绪条件、失败策略和监控开关。"],
  containers: ["容器管理", "按项目分组查看容器状态，并执行安全操作。"],
  logs: ["事件日志", "筛选、导出或清空巡检和操作记录。"],
  settings: ["系统设置", "调整后台守护、保护策略和配置备份。"],
};

const state = {
  activeView: "dashboard",
  containers: [],
  config: null,
  monitor: null,
  logs: [],
  details: null,
  dockerError: "",
  loading: false,
  filters: {
    query: "",
    status: "all",
    monitoredOnly: false,
    groupByProject: true,
    logQuery: "",
  },
};

let pendingConfirm = null;

const basePath = String(window.DOCKER_MANAGER_BASE || "/app/dockermanager").replace(/\/$/, "");
const $ = (id) => document.getElementById(id);

function route(path) {
  return `${basePath}/${String(path).replace(/^\.\//, "").replace(/^\//, "")}`;
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

async function refreshAll() {
  await loadContainers();
  await loadMonitor();
  await loadLogs();
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
  } catch (error) {
    state.monitor = { lastError: error.message };
  }
  renderDashboard();
}

async function loadLogs() {
  try {
    state.logs = await api(route("api/logs"));
  } catch (error) {
    state.logs = [{ time: "", type: "error", message: error.message }];
  }
  renderLogs();
  renderRecentLogs();
}

async function loadDetails(id) {
  state.details = { loading: true, id };
  renderDetails();
  try {
    state.details = await api(route(`api/containers/${encodeURIComponent(id)}/details`));
  } catch (error) {
    const fallback = state.containers.find((item) => item.id === id);
    state.details = { ...(fallback || { id, name: id }), error: error.message };
  }
  renderDetails();
}

function setView(view) {
  state.activeView = view;
  const [title, subtitle] = pageMeta[view] || pageMeta.dashboard;
  $("pageTitle").textContent = title;
  $("pageSubtitle").textContent = subtitle;
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `${view}View`);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
}

function render() {
  setView(state.activeView);
  renderDashboard();
  renderSettings();
  renderPlan();
  renderInventory();
  renderLogs();
  renderRecentLogs();
  renderDetails();
}

function renderDashboard() {
  const cfg = draftConfig();
  const running = state.containers.filter((item) => item.state === "running" && !item.missing);
  const bad = state.containers.filter(isProblem);
  const monitored = state.containers.filter((item) => (cfg.containers[item.id]?.monitor ?? item.config?.monitor) !== false);
  setText("dockerState", state.dockerError ? "不可用" : "正常");
  setText("monitorState", monitorText());
  setText("containerCount", String(state.containers.length));
  setText("badCount", String(bad.length));
  setText("monitoredCount", String(monitored.length));
  setText("runningCount", String(running.length));
  setText("nextCheck", state.monitor?.nextCheckAt ? formatTime(state.monitor.nextCheckAt) : "-");
  renderChainSummary();
  renderProblemList(bad);
}

function renderChainSummary() {
  const cfg = draftConfig();
  const rows = [...state.containers]
    .sort((a, b) => (cfg.containers[a.id]?.startupOrder ?? 0) - (cfg.containers[b.id]?.startupOrder ?? 0))
    .slice(0, 8);
  $("chainSummary").innerHTML =
    rows.length === 0
      ? '<div class="empty compact-empty">没有容器。</div>'
      : rows
          .map((container) => {
            const item = cfg.containers[container.id] || container.config || {};
            return `<div class="chain-row">
              <span class="order-dot">${numberValue(item.startupOrder, 0)}</span>
              <strong title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</strong>
              <span class="status ${escapeHtml(statusClass(container))}">${escapeHtml(statusText(container))}</span>
            </div>`;
          })
          .join("");
}

function renderProblemList(bad) {
  $("problemList").innerHTML =
    bad.length === 0
      ? '<div class="empty compact-empty">暂无需要处理的容器。</div>'
      : bad
          .slice(0, 6)
          .map(
            (container) => `<button class="problem-row" type="button" data-id="${escapeHtml(container.id)}">
              <span class="status ${escapeHtml(statusClass(container))}">${escapeHtml(statusText(container))}</span>
              <strong title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</strong>
              <small>${escapeHtml(composeLabel(container))}</small>
            </button>`,
          )
          .join("");
}

function renderSettings() {
  const cfg = draftConfig();
  $("checkInterval").value = cfg.settings.checkIntervalSeconds || 60;
  $("retryDelay").value = cfg.settings.startupRetryDelaySeconds || 10;
  $("startupTimeout").value = cfg.settings.startupTimeoutSeconds || 120;
  $("logRetention").value = cfg.settings.logRetentionLines || 500;
  $("autoRunOnStart").checked = cfg.settings.autoRunOnStart !== false;
  $("protectManager").checked = cfg.settings.protectManagerContainers !== false;
}

function renderPlan() {
  const cfg = draftConfig();
  const rows = [...state.containers].sort((a, b) => {
    const left = cfg.containers[a.id]?.startupOrder ?? a.config?.startupOrder ?? 0;
    const right = cfg.containers[b.id]?.startupOrder ?? b.config?.startupOrder ?? 0;
    if (left !== right) return left - right;
    return a.name.localeCompare(b.name);
  });
  $("planRows").innerHTML =
    rows.length === 0
      ? '<div class="empty">没有发现容器。</div>'
      : rows.map((container) => renderPlanRow(container, cfg)).join("");
}

function renderPlanRow(container, cfg) {
  const item = cfg.containers[container.id] || container.config || {};
  const disabled = container.missing ? "disabled" : "";
  return `<article class="plan-row ${container.missing ? "is-missing" : ""}" data-id="${escapeHtml(container.id)}">
    <div class="plan-main">
      <span class="order-pill">${numberValue(item.startupOrder, 0)}</span>
      <div class="container-title">
        <strong title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</strong>
        <span>${escapeHtml(composeLabel(container))}</span>
      </div>
      <span class="status ${escapeHtml(statusClass(container))}">${escapeHtml(statusText(container))}</span>
    </div>
    <div class="plan-controls">
      <label>顺序<input ${disabled} name="startupOrder-${escapeHtml(container.id)}" data-field="startupOrder" type="number" min="0" value="${numberValue(item.startupOrder, 0)}" /></label>
      <label>延迟<input ${disabled} name="startupDelaySeconds-${escapeHtml(container.id)}" data-field="startupDelaySeconds" type="number" min="0" value="${numberValue(item.startupDelaySeconds, 0)}" /></label>
      <label>就绪
        <select ${disabled} name="readinessMode-${escapeHtml(container.id)}" data-field="readinessMode">
          ${option("auto", "自动", item.readinessMode)}
          ${option("running", "运行即可", item.readinessMode)}
          ${option("healthy", "必须健康", item.readinessMode)}
        </select>
      </label>
      <label>失败
        <select ${disabled} name="failurePolicy-${escapeHtml(container.id)}" data-field="failurePolicy">
          ${option("retry", "自动重试", item.failurePolicy)}
          ${option("log", "只记录", item.failurePolicy)}
        </select>
      </label>
      <label class="switch"><input ${disabled} name="monitor-${escapeHtml(container.id)}" data-field="monitor" type="checkbox" ${item.monitor !== false ? "checked" : ""} />监控</label>
    </div>
  </article>`;
}

function renderInventory() {
  const visible = filteredContainers();
  $("emptyState").classList.toggle("hidden", visible.length !== 0);
  if (visible.length === 0) {
    $("inventoryRows").innerHTML = "";
    return;
  }
  const groups = groupContainers(visible);
  $("inventoryRows").innerHTML = groups
    .map(
      (group) => `<section class="container-group">
        ${state.filters.groupByProject ? `<h3>${escapeHtml(group.name)}</h3>` : ""}
        ${group.items.map(renderInventoryRow).join("")}
      </section>`,
    )
    .join("");
}

function renderInventoryRow(container) {
  const portText = formatPorts(container.ports);
  const protectedText = container.protected ? '<span class="tag">保护</span>' : "";
  return `<article class="container-row ${container.missing ? "is-missing" : ""}" data-id="${escapeHtml(container.id)}">
    <button class="row-open" data-action="details" type="button">
      <span class="container-name" title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</span>
      <span class="container-meta">${escapeHtml(container.image || "未记录镜像")}</span>
    </button>
    <div class="container-state">
      <span class="status ${escapeHtml(statusClass(container))}">${escapeHtml(statusText(container))}</span>
      ${protectedText}
    </div>
    <div class="container-extra">
      <span title="${escapeHtml(composeLabel(container))}">${escapeHtml(composeLabel(container))}</span>
      <span title="${escapeHtml(portText)}">${escapeHtml(portText || "无端口")}</span>
    </div>
    <div class="row-actions">
      <button data-action="start" type="button" ${container.missing ? "disabled" : ""}>启动</button>
      <button data-action="restart" type="button" ${container.missing || container.protected ? "disabled" : ""}>重启</button>
      <button data-action="stop" class="danger" type="button" ${container.missing || container.protected ? "disabled" : ""}>停止</button>
    </div>
  </article>`;
}

function renderLogs() {
  const query = state.filters.logQuery.trim().toLowerCase();
  const logs = query
    ? state.logs.filter((item) => `${item.type || ""} ${item.message || ""}`.toLowerCase().includes(query))
    : state.logs;
  $("logs").innerHTML =
    logs.length === 0
      ? '<div class="empty compact-empty">暂无日志。</div>'
      : logs.map(renderLogItem).join("");
}

function renderRecentLogs() {
  $("recentLogs").innerHTML =
    state.logs.length === 0 ? '<div class="empty compact-empty">暂无事件。</div>' : state.logs.slice(0, 5).map(renderLogItem).join("");
}

function renderLogItem(item) {
  return `<div class="log-item">
    <time>${escapeHtml(formatTime(item.time) || "")}</time>
    <span>${escapeHtml(item.type || "event")}</span>
    <p>${escapeHtml(item.message || "")}</p>
  </div>`;
}

function renderDetails() {
  const drawer = $("detailDrawer");
  const detail = state.details;
  drawer.classList.toggle("hidden", !detail);
  if (!detail) return;
  $("detailTitle").textContent = detail.loading ? "正在加载" : detail.name || detail.id;
  $("detailSubtitle").textContent = detail.loading ? "" : detail.image || "";
  if (detail.loading) {
    $("detailBody").innerHTML = '<div class="empty">正在读取容器详情。</div>';
    return;
  }
  $("detailBody").innerHTML = `
    ${detail.error ? `<div class="alert">${escapeHtml(detail.error)}</div>` : ""}
    ${detail.protected ? '<div class="notice">此容器受到保护，不能在 Docker Manager 中停止或重启。</div>' : ""}
    <dl>
      ${detailLine("ID", detail.id)}
      ${detailLine("状态", `${statusText(detail)} / ${detail.status || "-"}`)}
      ${detailLine("Compose", composeLabel(detail))}
      ${detailLine("端口", formatPorts(detail.ports) || "无端口")}
      ${detailLine("网络", formatNetworks(detail.networks) || "无网络")}
      ${detailLine("挂载", formatMounts(detail.mounts) || "无挂载")}
      ${detailLine("创建时间", detail.created ? new Date(detail.created * 1000).toLocaleString() : "-")}
    </dl>`;
}

function filteredContainers() {
  const cfg = draftConfig();
  const query = state.filters.query.trim().toLowerCase();
  return state.containers.filter((container) => {
    const item = cfg.containers[container.id] || container.config || {};
    if (state.filters.monitoredOnly && item.monitor === false) return false;
    if (state.filters.status === "running" && isProblem(container)) return false;
    if (state.filters.status === "problem" && !isProblem(container)) return false;
    if (state.filters.status === "stopped" && (container.state === "running" || container.missing)) return false;
    if (state.filters.status === "missing" && !container.missing) return false;
    if (!query) return true;
    return [container.name, container.image, container.id, container.composeProject, container.composeService, container.status]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
}

function groupContainers(containers) {
  if (!state.filters.groupByProject) return [{ name: "", items: containers }];
  const map = new Map();
  for (const container of containers) {
    const key = container.composeProject || "未分组";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(container);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, items]) => ({ name, items }));
}

function syncSettingsToDraft() {
  const cfg = draftConfig();
  cfg.settings = {
    checkIntervalSeconds: Number($("checkInterval").value),
    startupRetryDelaySeconds: Number($("retryDelay").value),
    startupTimeoutSeconds: Number($("startupTimeout").value),
    logRetentionLines: Number($("logRetention").value),
    autoRunOnStart: $("autoRunOnStart").checked,
    protectManagerContainers: $("protectManager").checked,
  };
}

function syncPlanRow(row) {
  if (!row) return;
  const id = row.dataset.id;
  const cfg = draftConfig();
  const current = cfg.containers[id] || {};
  cfg.containers[id] = {
    ...current,
    enabled: true,
    startupOrder: Number(row.querySelector('[data-field="startupOrder"]').value),
    startupDelaySeconds: Number(row.querySelector('[data-field="startupDelaySeconds"]').value),
    readinessMode: row.querySelector('[data-field="readinessMode"]').value,
    failurePolicy: row.querySelector('[data-field="failurePolicy"]').value,
    monitor: row.querySelector('[data-field="monitor"]').checked,
  };
}

function collectConfig() {
  syncSettingsToDraft();
  document.querySelectorAll(".plan-row[data-id]").forEach(syncPlanRow);
  return draftConfig();
}

async function saveConfig() {
  try {
    state.config = await api(route("api/config"), {
      method: "PUT",
      body: JSON.stringify(collectConfig()),
    });
    await loadContainers();
    showAlert("配置已保存。");
  } catch (error) {
    showAlert(error.message);
  }
}

async function runAction(action, id) {
  const container = state.containers.find((item) => item.id === id);
  const label = container?.name || id;
  if (action === "stop" || action === "restart") {
    confirmAction(`${action === "stop" ? "停止" : "重启"}容器`, `确认${action === "stop" ? "停止" : "重启"} ${label}？`, "确认", () =>
      postContainerAction(action, id),
    );
    return;
  }
  await postContainerAction(action, id);
}

async function postContainerAction(action, id) {
  setLoading(true);
  try {
    await api(route(`api/containers/${encodeURIComponent(id)}/${action}`), { method: "POST" });
    await refreshAll();
  } catch (error) {
    showAlert(error.message);
  } finally {
    setLoading(false);
  }
}

async function runOrderedStartup() {
  setLoading(true);
  try {
    await api(route("api/actions/startup-run"), { method: "POST" });
    await refreshAll();
  } catch (error) {
    showAlert(error.message);
  } finally {
    setLoading(false);
  }
}

async function clearLogs() {
  confirmAction("清空日志", "确认清空所有 Docker Manager 事件日志？", "清空", async () => {
    await api(route("api/logs/clear"), { method: "POST" });
    state.logs = [];
    renderLogs();
    renderRecentLogs();
  });
}

function exportConfig() {
  downloadJSON("docker-manager-config.json", collectConfig());
}

function exportLogs() {
  downloadJSON("docker-manager-logs.json", state.logs);
}

async function importConfig(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !parsed.containers || !parsed.settings) {
      throw new Error("配置文件格式不正确。");
    }
    confirmAction("导入配置", `检测到 ${Object.keys(parsed.containers).length} 个容器配置，确认覆盖当前配置？`, "导入", async () => {
      state.config = await api(route("api/config"), {
        method: "PUT",
        body: JSON.stringify(parsed),
      });
      await loadContainers();
      showAlert("配置已导入。");
    });
  } catch (error) {
    showAlert(error.message);
  } finally {
    $("importConfigInput").value = "";
  }
}

function confirmAction(title, message, confirmText, onConfirm) {
  pendingConfirm = onConfirm;
  $("modalTitle").textContent = title;
  $("modalMessage").textContent = message;
  $("modalConfirmBtn").textContent = confirmText;
  $("modalBackdrop").classList.remove("hidden");
}

function defaultConfig() {
  return {
    version: 2,
    settings: {
      checkIntervalSeconds: 60,
      startupRetryDelaySeconds: 10,
      startupTimeoutSeconds: 120,
      autoRunOnStart: true,
      protectManagerContainers: true,
      logRetentionLines: 500,
    },
    containers: {},
  };
}

function draftConfig() {
  if (!state.config) state.config = defaultConfig();
  state.config.settings ||= defaultConfig().settings;
  state.config.containers ||= {};
  return state.config;
}

function monitorText() {
  if (state.monitor?.running) return "巡检中";
  if (state.monitor?.lastError) return "有异常";
  if (state.monitor?.lastFinishedAt) return "正常";
  return "等待首次巡检";
}

function isProblem(container) {
  return container.missing || container.state !== "running" || container.health === "unhealthy";
}

function statusClass(container) {
  if (container.missing) return "missing";
  if (container.health === "unhealthy") return "unhealthy";
  if (container.health === "healthy") return "healthy";
  return String(container.state || "unknown").toLowerCase();
}

function statusText(container) {
  if (container.missing) return "已失联";
  if (container.health === "unhealthy") return "异常";
  if (container.health === "healthy") return "健康";
  const map = {
    created: "已创建",
    dead: "失效",
    exited: "已停止",
    paused: "已暂停",
    restarting: "重启中",
    running: "运行中",
  };
  return map[String(container.state || "").toLowerCase()] || container.status || "未知";
}

function composeLabel(container) {
  if (container.composeProject && container.composeService) return `${container.composeProject} / ${container.composeService}`;
  if (container.composeProject) return container.composeProject;
  return "未分组";
}

function formatPorts(ports = []) {
  return ports
    .filter((port) => port.privatePort)
    .map((port) => (port.publicPort ? `${port.publicPort}:${port.privatePort}/${port.type}` : `${port.privatePort}/${port.type}`))
    .join(", ");
}

function formatNetworks(networks = []) {
  return networks.map((item) => `${item.name}${item.ipAddress ? ` (${item.ipAddress})` : ""}`).join(", ");
}

function formatMounts(mounts = []) {
  return mounts.map((item) => `${item.source || item.type} -> ${item.destination}`).join("\n");
}

function detailLine(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "-")}</dd>`;
}

function option(value, label, current) {
  return `<option value="${value}" ${String(current || "auto") === value ? "selected" : ""}>${label}</option>`;
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

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function showAlert(message) {
  const el = $("alert");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function setLoading(loading) {
  state.loading = loading;
  document.querySelectorAll("button").forEach((button) => {
    if (button.closest(".modal")) return;
    if (loading) {
      button.dataset.wasDisabled = button.disabled ? "true" : "false";
      button.disabled = true;
      return;
    }
    if (button.dataset.wasDisabled) {
      button.disabled = button.dataset.wasDisabled === "true";
      delete button.dataset.wasDisabled;
    }
  });
}

function downloadJSON(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
document.querySelectorAll("[data-jump]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.jump));
});
$("refreshBtn").addEventListener("click", refreshAll);
$("startupBtn").addEventListener("click", runOrderedStartup);
$("saveBtn").addEventListener("click", saveConfig);
$("saveSettingsBtn").addEventListener("click", saveConfig);
$("searchInput").addEventListener("input", (event) => {
  state.filters.query = event.target.value;
  renderInventory();
});
$("statusFilter").addEventListener("change", (event) => {
  state.filters.status = event.target.value;
  renderInventory();
});
$("monitoredOnly").addEventListener("change", (event) => {
  state.filters.monitoredOnly = event.target.checked;
  renderInventory();
});
$("groupByProject").addEventListener("change", (event) => {
  state.filters.groupByProject = event.target.checked;
  renderInventory();
});
$("logSearchInput").addEventListener("input", (event) => {
  state.filters.logQuery = event.target.value;
  renderLogs();
});
$("planRows").addEventListener("input", (event) => {
  if (event.target.matches("[data-field]")) syncPlanRow(event.target.closest(".plan-row"));
});
$("planRows").addEventListener("change", (event) => {
  if (event.target.matches("[data-field]")) syncPlanRow(event.target.closest(".plan-row"));
});
$("inventoryRows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("[data-id]");
  const action = button.dataset.action;
  if (action === "details") {
    loadDetails(row.dataset.id);
    return;
  }
  runAction(action, row.dataset.id);
});
$("problemList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-id]");
  if (!row) return;
  setView("containers");
  loadDetails(row.dataset.id);
});
$("closeDetailsBtn").addEventListener("click", () => {
  state.details = null;
  renderDetails();
});
$("exportConfigBtn").addEventListener("click", exportConfig);
$("importConfigBtn").addEventListener("click", () => $("importConfigInput").click());
$("importConfigInput").addEventListener("change", (event) => importConfig(event.target.files?.[0]));
$("exportLogsBtn").addEventListener("click", exportLogs);
$("clearLogsBtn").addEventListener("click", clearLogs);
$("modalCancelBtn").addEventListener("click", () => {
  pendingConfirm = null;
  $("modalBackdrop").classList.add("hidden");
});
$("modalConfirmBtn").addEventListener("click", async () => {
  const action = pendingConfirm;
  pendingConfirm = null;
  $("modalBackdrop").classList.add("hidden");
  if (action) {
    try {
      await action();
    } catch (error) {
      showAlert(error.message);
    }
  }
});

await refreshAll();
setInterval(loadMonitor, 15000);
