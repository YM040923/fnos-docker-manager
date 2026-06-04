const state = {
  containers: [],
  config: null,
  loading: false,
};

const $ = (id) => document.getElementById(id);

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
    const result = await api("./api/containers");
    state.containers = result.containers;
    state.config = result.config;
    showAlert("");
    render();
  } catch (error) {
    $("dockerState").textContent = "不可用";
    showAlert(error.message);
    render();
  } finally {
    setLoading(false);
  }
}

async function loadLogs() {
  try {
    const logs = await api("./api/logs");
    $("logs").innerHTML =
      logs.length === 0
        ? '<div class="empty">暂无日志。</div>'
        : logs
            .map(
              (item) => `<div class="log-item"><time>${escapeHtml(item.time || "")}</time>${escapeHtml(
                item.message || "",
              )}</div>`,
            )
            .join("");
  } catch (error) {
    $("logs").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function render() {
  const rows = $("containerRows");
  const config = state.config || { settings: {}, containers: {} };
  $("dockerState").textContent = state.containers.length > 0 ? "正常" : "未知";
  $("containerCount").textContent = String(state.containers.length);
  $("badCount").textContent = String(state.containers.filter((item) => item.state !== "running").length);
  $("lastRefresh").textContent = new Date().toLocaleTimeString();
  $("emptyState").classList.toggle("hidden", state.containers.length !== 0);
  $("checkInterval").value = config.settings.checkIntervalSeconds || 60;
  $("retryDelay").value = config.settings.startupRetryDelaySeconds || 10;
  $("startupTimeout").value = config.settings.startupTimeoutSeconds || 120;

  rows.innerHTML = state.containers
    .map((container) => {
      const item = config.containers[container.id] || {};
      const statusClass = container.health === "unhealthy" ? "unhealthy" : container.state;
      return `<tr data-id="${escapeHtml(container.id)}">
        <td><input data-field="startupOrder" type="number" min="0" value="${numberValue(item.startupOrder, 0)}" /></td>
        <td><strong>${escapeHtml(container.name)}</strong><br /><small>${escapeHtml(container.id.slice(0, 12))}</small></td>
        <td>${escapeHtml(container.image)}</td>
        <td><span class="status ${escapeHtml(statusClass)}">${escapeHtml(container.status || container.state)}</span></td>
        <td><input data-field="startupDelaySeconds" type="number" min="0" value="${numberValue(
          item.startupDelaySeconds,
          0,
        )}" /></td>
        <td><input data-field="monitor" type="checkbox" ${item.monitor !== false ? "checked" : ""} /></td>
        <td><div class="row-actions">
          <button data-action="start">启动</button>
          <button data-action="stop">停止</button>
          <button data-action="restart">重启</button>
        </div></td>
      </tr>`;
    })
    .join("");
}

function collectConfig() {
  const config = structuredClone(state.config || { version: 1, settings: {}, containers: {} });
  config.settings = {
    checkIntervalSeconds: Number($("checkInterval").value),
    startupRetryDelaySeconds: Number($("retryDelay").value),
    startupTimeoutSeconds: Number($("startupTimeout").value),
  };
  document.querySelectorAll("tbody tr[data-id]").forEach((row) => {
    const id = row.dataset.id;
    config.containers[id] = {
      ...(config.containers[id] || {}),
      enabled: true,
      startupOrder: Number(row.querySelector('[data-field="startupOrder"]').value),
      startupDelaySeconds: Number(row.querySelector('[data-field="startupDelaySeconds"]').value),
      monitor: row.querySelector('[data-field="monitor"]').checked,
    };
  });
  return config;
}

async function saveConfig() {
  try {
    state.config = await api("./api/config", {
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

$("refreshBtn").addEventListener("click", loadContainers);
$("saveBtn").addEventListener("click", saveConfig);
$("startupBtn").addEventListener("click", () => runAction("./api/actions/startup-run"));
$("reloadLogsBtn").addEventListener("click", loadLogs);
$("containerRows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("tr[data-id]");
  runAction(`./api/containers/${encodeURIComponent(row.dataset.id)}/${button.dataset.action}`);
});

await loadContainers();
await loadLogs();
