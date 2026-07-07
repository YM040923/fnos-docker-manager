export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function statusPill(className, text) {
  return `<span class="status ${escapeHtml(className)}">${escapeHtml(text)}</span>`;
}

export function metricCard({ label, value, caption, tone = "neutral", accent = "↘" }) {
  return `<article class="stat-card tone-${escapeHtml(tone)}">
    <div class="metric-head">
      <span>${escapeHtml(label)}</span>
      <i aria-hidden="true">${escapeHtml(accent)}</i>
    </div>
    <strong>${escapeHtml(value)}</strong>
    <p>${escapeHtml(caption)}</p>
  </article>`;
}

export function chainRow({ order, name, statusClass, statusText }) {
  return `<div class="chain-row">
    <span class="order-dot">${escapeHtml(order)}</span>
    <strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
    ${statusPill(statusClass, statusText)}
  </div>`;
}

export function problemRow({ id, name, meta, statusClass, statusText }) {
  return `<button class="problem-row" type="button" data-id="${escapeHtml(id)}">
    ${statusPill(statusClass, statusText)}
    <strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
    <small>${escapeHtml(meta)}</small>
  </button>`;
}

export function selectionCard({ id, mode, name, statusClass, statusText, selected, missing = false, metaHtml, draggable = true }) {
  return `<article class="select-card ${selected ? "is-selected" : ""} ${missing ? "is-missing" : ""}" data-id="${escapeHtml(id)}" data-select-mode="${escapeHtml(mode)}" data-selected="${selected ? "true" : "false"}" data-status="${escapeHtml(statusClass)}" role="button" draggable="${draggable ? "true" : "false"}" tabindex="0" aria-pressed="${selected ? "true" : "false"}">
    <div class="select-card-head">
      <strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
      ${statusPill(statusClass, statusText)}
    </div>
    ${metaHtml}
  </article>`;
}

export function logItem({ time, type, message }) {
  return `<div class="log-item">
    <time>${escapeHtml(time || "")}</time>
    <span>${escapeHtml(type || "event")}</span>
    <p>${escapeHtml(message || "")}</p>
  </div>`;
}

export function detailLine(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "-")}</dd>`;
}
