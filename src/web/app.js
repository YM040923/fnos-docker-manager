import { setGuardParticipation, setStartupParticipation } from "./container-policy.js";
import { nextSelectionOrder, positionInMode, reorderModeConfig, sortSelectionContainers } from "./selection-order.js";
import {
  chainRow,
  detailLine,
  escapeHtml,
  logItem as logItemView,
  metricCard,
  problemRow,
  selectionCard,
} from "./ui-components.js";

const pageMeta = {
  dashboard: ["控制台", "查看 Docker 守护状态、异常容器和最近事件。"],
  orchestration: ["编排管理", "点击容器选择是否参与启动编排。"],
  guard: ["守护管理", "点击容器选择是否由后台巡检守护。"],
  logs: ["事件日志", "筛选、导出或清空巡检和操作记录。"],
  settings: ["系统设置", "调整后台守护、保护策略和配置备份。"],
};

function initialView() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "plan" || view === "containers") return "orchestration";
  return Object.hasOwn(pageMeta, view) ? view : "dashboard";
}

const state = {
  activeView: initialView(),
  containers: [],
  config: null,
  monitor: null,
  logs: [],
  details: null,
  dockerError: "",
  loading: false,
  filters: {
    orchestrationQuery: "",
    orchestrationStatus: "all",
    orchestrationColumns: "3",
    guardQuery: "",
    guardStatus: "all",
    guardColumns: "3",
    logQuery: "",
  },
};

let pendingConfirm = null;
let dragState = null;
let suppressNextSelectionClick = false;

const basePath = String(window.DOCKER_MANAGER_BASE || "/app/dockerstart").replace(/\/$/, "");
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
  document.body.dataset.view = view;
  const [title, subtitle] = pageMeta[view] || pageMeta.dashboard;
  $("pageTitle").textContent = title;
  $("pageSubtitle").textContent = subtitle;
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `${view}View`);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
}

function render() {
  setView(state.activeView);
  renderDashboard();
  renderSettings();
  renderOrchestration();
  renderGuard();
  renderLogs();
  renderRecentLogs();
  renderDetails();
}

function renderDashboard() {
  const cfg = draftConfig();
  const running = state.containers.filter((item) => item.state === "running" && !item.missing);
  const bad = state.containers.filter(isProblem);
  const monitored = state.containers.filter((item) => isGuarded(item, cfg));
  $("statGrid").innerHTML = [
    metricCard({
      label: "Docker 状态",
      value: state.dockerError ? "不可用" : "正常",
      caption: "Docker socket 访问状态",
      tone: state.dockerError ? "danger" : "neutral",
      accent: "↙",
    }),
    metricCard({
      label: "后台守护",
      value: monitorText(),
      caption: "顺序巡检和自动恢复",
      tone: state.monitor?.lastError ? "danger" : "neutral",
      accent: "↗",
    }),
    metricCard({
      label: "容器总数",
      value: String(state.containers.length),
      caption: "已发现和已记录容器",
      tone: "neutral",
      accent: "↙",
    }),
    metricCard({
      label: "需要处理",
      value: String(bad.length),
      caption: "停止或异常",
      tone: bad.length > 0 ? "warning" : "neutral",
      accent: "↗",
    }),
  ].join("");
  setText("monitoredCount", String(monitored.length));
  setText("runningCount", String(running.length));
  setText("nextCheck", state.monitor?.nextCheckAt ? formatTime(state.monitor.nextCheckAt) : "-");
  renderChainSummary();
  renderProblemList(bad);
}

function renderChainSummary() {
  const cfg = draftConfig();
  const rows = [...state.containers]
    .filter((container) => isOrchestrated(container, cfg))
    .sort((a, b) => orderOf(a, cfg) - orderOf(b, cfg) || a.name.localeCompare(b.name));
  $("chainSummary").innerHTML =
    rows.length === 0
      ? '<div class="empty compact-empty">还没有容器纳入启动编排。</div>'
      : rows
          .map((container, index) =>
            chainRow({
              order: index + 1,
              name: container.name,
              statusClass: statusClass(container),
              statusText: statusText(container),
            }),
          )
          .join("");
}

function renderProblemList(bad) {
  $("problemList").innerHTML =
    bad.length === 0
      ? '<div class="empty compact-empty">暂无需要处理的容器。</div>'
      : bad
          .slice(0, 6)
          .map((container) =>
            problemRow({
              id: container.id,
              name: container.name,
              meta: composeLabel(container),
              statusClass: statusClass(container),
              statusText: statusText(container),
            }),
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

function renderOrchestration() {
  const cfg = draftConfig();
  const visible = filteredManagerContainers("orchestration");
  const selected = orderedStartupContainers(cfg);
  setText("orchestrationCount", String(selected.length));
  renderSelectionGrid("orchestration", visible);
}

function renderGuard() {
  const cfg = draftConfig();
  const visible = filteredManagerContainers("guard");
  const selected = state.containers.filter((container) => isGuarded(container, cfg));
  setText("guardCount", String(selected.length));
  renderSelectionGrid("guard", visible);
}

function renderSelectionGrid(mode, visible) {
  const gridId = mode === "guard" ? "guardRows" : "orchestrationRows";
  const emptyId = mode === "guard" ? "guardEmptyState" : "orchestrationEmptyState";
  const columns = mode === "guard" ? state.filters.guardColumns : state.filters.orchestrationColumns;
  const grid = $(gridId);
  grid.className = `selection-grid cols-${escapeHtml(columns)}`;
  $(emptyId).classList.toggle("hidden", visible.length !== 0);
  const sorted = sortSelectionContainers(visible, draftConfig(), mode);
  grid.innerHTML = visible.length === 0 ? "" : sorted.map((container) => renderSelectionCard(container, mode)).join("");
}

function renderSelectionCard(container, mode) {
  const cfg = draftConfig();
  const item = cfg.containers[container.id] || container.config || {};
  const selected = mode === "guard" ? isGuarded(container, cfg) : isOrchestrated(container, cfg);
  const position = selected && mode === "orchestration" ? positionInMode(container.id, state.containers, cfg, mode) : 0;
  return selectionCard({
    id: container.id,
    mode,
    name: container.name,
    statusClass: statusClass(container),
    statusText: statusText(container),
    selected,
    missing: container.missing,
    draggable: mode === "orchestration",
    metaHtml: mode === "orchestration" ? renderStartupCardMeta(container, item, selected, position) : renderGuardCardMeta(selected),
  });
}

function renderStartupCardMeta(container, item, selected, startupIndex) {
  if (!selected) {
    return '<div class="select-card-meta"><span class="select-chip muted">未编排</span></div>';
  }
  return `<div class="select-card-meta">
    <span class="select-chip">第 ${startupIndex} 个启动</span>
    <label class="inline-delay">
      <span>启动后等待</span>
      <input name="startupDelaySeconds-${escapeHtml(container.id)}" data-startup-delay type="number" min="0" max="3600" value="${numberValue(item.startupDelaySeconds, 0)}" />
      <span>秒</span>
    </label>
  </div>`;
}

function renderGuardCardMeta(selected) {
  return `<div class="select-card-meta">
    <span class="select-chip ${selected ? "" : "muted"}">${selected ? "已守护" : "未守护"}</span>
  </div>`;
}

function orderedStartupContainers(cfg = draftConfig()) {
  return [...state.containers]
    .filter((container) => isOrchestrated(container, cfg))
    .sort((a, b) => orderOf(a, cfg) - orderOf(b, cfg) || a.name.localeCompare(b.name));
}

function toggleParticipation(id, mode) {
  const cfg = draftConfig();
  const container = state.containers.find((item) => item.id === id);
  if (!container) return;
  const current = {
    ...(cfg.containers[id] || container.config || {}),
    name: container.name || id,
    image: container.image || "",
  };
  const selected = mode === "guard" ? current.monitor === true : current.enabled === true;
  let next =
    mode === "guard"
      ? setGuardParticipation(current, !selected)
      : setStartupParticipation(current, !selected);
  if (mode === "orchestration" && !selected) {
    next = { ...next, startupOrder: nextSelectionOrder(cfg, mode) };
  }
  if (mode === "guard" && !selected) {
    next = { ...next, monitorOrder: nextSelectionOrder(cfg, mode) };
  }
  cfg.containers[id] = next;
  renderDashboard();
  renderOrchestration();
  renderGuard();
}

function reorderSelection(draggedId, targetId, mode) {
  state.config = reorderModeConfig({
    config: draftConfig(),
    containers: state.containers,
    mode,
    draggedId,
    targetId,
  });
  renderDashboard();
  renderOrchestration();
  renderGuard();
}

function updateStartupDelay(id, value) {
  const cfg = draftConfig();
  const current = cfg.containers[id] || {};
  cfg.containers[id] = {
    ...current,
    startupDelaySeconds: numberValue(value, current.startupDelaySeconds || 0),
  };
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
  return logItemView({
    time: formatTime(item.time),
    type: item.type,
    message: item.message,
  });
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

function filteredManagerContainers(mode) {
  const query = (mode === "guard" ? state.filters.guardQuery : state.filters.orchestrationQuery).trim().toLowerCase();
  const status = mode === "guard" ? state.filters.guardStatus : state.filters.orchestrationStatus;
  return state.containers.filter((container) => {
    if (status === "running" && isProblem(container)) return false;
    if (status === "problem" && !isProblem(container)) return false;
    if (status === "stopped" && container.state === "running") return false;
    if (!query) return true;
    return [container.name, container.id].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
  });
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

function collectConfig() {
  syncSettingsToDraft();
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

function option(value, label, current) {
  return `<option value="${value}" ${String(current || "auto") === value ? "selected" : ""}>${label}</option>`;
}

function numberValue(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function isOrchestrated(container, cfg = draftConfig()) {
  const item = cfg.containers[container.id] || container.config || {};
  return item.enabled === true;
}

function isGuarded(container, cfg = draftConfig()) {
  const item = cfg.containers[container.id] || container.config || {};
  return item.monitor === true;
}

function orderOf(container, cfg = draftConfig()) {
  const item = cfg.containers[container.id] || container.config || {};
  return numberValue(item.startupOrder, Number.MAX_SAFE_INTEGER);
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
    if (button.closest(".nav")) return;
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

function attachSelectionGrid(id) {
  const grid = $(id);
  grid.addEventListener("dragstart", (event) => {
    if (event.target.closest("input, select, button, label")) return;
    const card = event.target.closest(".select-card[data-id]");
    if (!card) return;
    if (card.dataset.selectMode !== "orchestration") {
      event.preventDefault();
      return;
    }
    dragState = {
      id: card.dataset.id,
      mode: card.dataset.selectMode,
    };
    card.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.dataset.id);
  });
  grid.addEventListener("dragover", (event) => {
    if (!dragState) return;
    if (dragState.mode !== "orchestration") return;
    const card = event.target.closest(".select-card[data-id]");
    if (!card) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      return;
    }
    if (card.dataset.selectMode !== dragState.mode || card.dataset.id === dragState.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    grid.querySelectorAll(".select-card.is-drop-target").forEach((item) => item.classList.remove("is-drop-target"));
    card.classList.add("is-drop-target");
  });
  grid.addEventListener("dragleave", (event) => {
    const card = event.target.closest(".select-card.is-drop-target");
    if (card && !card.contains(event.relatedTarget)) card.classList.remove("is-drop-target");
  });
  grid.addEventListener("drop", (event) => {
    if (!dragState) return;
    if (dragState.mode !== "orchestration") return;
    const card = event.target.closest(".select-card[data-id]");
    if (card && card.dataset.selectMode !== dragState.mode) return;
    event.preventDefault();
    reorderSelection(dragState.id, card?.dataset.id, dragState.mode);
    dragState = null;
    suppressNextSelectionClick = true;
  });
  grid.addEventListener("dragend", () => {
    grid.querySelectorAll(".select-card.is-dragging, .select-card.is-drop-target").forEach((card) => {
      card.classList.remove("is-dragging", "is-drop-target");
    });
    dragState = null;
  });
  grid.addEventListener("click", (event) => {
    if (suppressNextSelectionClick) {
      suppressNextSelectionClick = false;
      return;
    }
    if (event.target.closest("input, select, button, label")) return;
    const card = event.target.closest(".select-card[data-id]");
    if (!card) return;
    toggleParticipation(card.dataset.id, card.dataset.selectMode);
  });
  grid.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".select-card[data-id]");
    if (!card) return;
    event.preventDefault();
    toggleParticipation(card.dataset.id, card.dataset.selectMode);
  });
  grid.addEventListener("input", (event) => {
    if (!event.target.matches("[data-startup-delay]")) return;
    const card = event.target.closest(".select-card[data-id]");
    if (!card) return;
    updateStartupDelay(card.dataset.id, event.target.value);
  });
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
$("saveGuardBtn").addEventListener("click", saveConfig);
$("orchestrationSearchInput").addEventListener("input", (event) => {
  state.filters.orchestrationQuery = event.target.value;
  renderOrchestration();
});
$("orchestrationStatusFilter").addEventListener("change", (event) => {
  state.filters.orchestrationStatus = event.target.value;
  renderOrchestration();
});
$("orchestrationColumns").addEventListener("change", (event) => {
  state.filters.orchestrationColumns = event.target.value;
  renderOrchestration();
});
$("guardSearchInput").addEventListener("input", (event) => {
  state.filters.guardQuery = event.target.value;
  renderGuard();
});
$("guardStatusFilter").addEventListener("change", (event) => {
  state.filters.guardStatus = event.target.value;
  renderGuard();
});
$("guardColumns").addEventListener("change", (event) => {
  state.filters.guardColumns = event.target.value;
  renderGuard();
});
$("logSearchInput").addEventListener("input", (event) => {
  state.filters.logQuery = event.target.value;
  renderLogs();
});
attachSelectionGrid("orchestrationRows");
attachSelectionGrid("guardRows");
$("problemList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-id]");
  if (!row) return;
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
