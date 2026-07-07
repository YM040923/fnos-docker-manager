import assert from "node:assert/strict";
import test from "node:test";
import { detailLine, metricCard, problemRow, selectionCard, statusPill } from "./ui-components.js";

test("metricCard escapes values and exposes tone class", () => {
  const html = metricCard({
    label: "<Docker>",
    value: "正常",
    caption: "socket <ok>",
    tone: "success",
  });

  assert.match(html, /class="stat-card tone-success"/);
  assert.match(html, /&lt;Docker&gt;/);
  assert.match(html, /socket &lt;ok&gt;/);
});

test("statusPill renders consistent status markup", () => {
  assert.equal(statusPill("running", "运行中"), '<span class="status running">运行中</span>');
});

test("selectionCard renders a clickable card without unrelated container metadata", () => {
  const html = selectionCard({
    id: "abc",
    mode: "guard",
    name: "moviepilot",
    statusClass: "running",
    statusText: "运行中",
    selected: true,
    metaHtml: '<span class="select-chip">后台守护中</span>',
  });

  assert.match(html, /role="button"/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /data-selected="true"/);
  assert.match(html, /data-status="running"/);
  assert.match(html, /is-selected/);
  assert.match(html, /data-select-mode="guard"/);
  assert.match(html, /moviepilot/);
  assert.doesNotMatch(html, /:latest|\/tcp|media \//);
});

test("selectionCard can disable dragging for non-ordered selection views", () => {
  const html = selectionCard({
    id: "abc",
    mode: "guard",
    name: "moviepilot",
    statusClass: "running",
    statusText: "运行中",
    selected: true,
    draggable: false,
    metaHtml: '<span class="select-chip">已守护</span>',
  });

  assert.match(html, /draggable="false"/);
});

test("problemRow keeps status and name in separate cells", () => {
  const html = problemRow({
    id: "postgres",
    name: "postgres",
    meta: "media / postgres",
    statusClass: "exited",
    statusText: "已停止",
  });

  assert.match(html, /class="problem-row"/);
  assert.match(html, /<span class="status exited">已停止<\/span>/);
  assert.match(html, /<strong title="postgres">postgres<\/strong>/);
});

test("detailLine escapes labels and multiline values", () => {
  assert.equal(detailLine("<ID>", "a&b"), "<dt>&lt;ID&gt;</dt><dd>a&amp;b</dd>");
});
