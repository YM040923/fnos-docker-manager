import assert from "node:assert/strict";
import test from "node:test";

import { nextSelectionOrder, positionInMode, reorderModeConfig, sortSelectionContainers } from "./selection-order.js";

const containers = [
  { id: "nginx", name: "nginx" },
  { id: "postgres", name: "postgres" },
  { id: "sonarr", name: "sonarr" },
  { id: "qbittorrent", name: "qbittorrent" },
];

test("sortSelectionContainers keeps selected cards first in configured order", () => {
  const config = {
    containers: {
      nginx: { enabled: true, startupOrder: 20 },
      sonarr: { enabled: true, startupOrder: 10 },
    },
  };

  assert.deepEqual(
    sortSelectionContainers(containers, config, "orchestration").map((item) => item.id),
    ["sonarr", "nginx", "postgres", "qbittorrent"],
  );
});

test("sortSelectionContainers keeps guarded cards first without using startup order", () => {
  const config = {
    containers: {
      nginx: { monitor: true, startupOrder: 20, monitorOrder: 20 },
      sonarr: { monitor: true, startupOrder: 10, monitorOrder: 10 },
    },
  };

  assert.deepEqual(
    sortSelectionContainers(containers, config, "guard").map((item) => item.id),
    ["sonarr", "nginx", "postgres", "qbittorrent"],
  );
});

test("sortSelectionContainers appends newly guarded cards after existing guarded cards", () => {
  const config = {
    containers: {
      nginx: { monitor: true, startupOrder: 20, monitorOrder: 10 },
      sonarr: { monitor: true, startupOrder: 10, monitorOrder: 20 },
      postgres: { monitor: true, startupOrder: 5, monitorOrder: 30 },
    },
  };

  assert.deepEqual(
    sortSelectionContainers(containers, config, "guard").map((item) => item.id),
    ["nginx", "sonarr", "postgres", "qbittorrent"],
  );
});

test("positionInMode reports selected orchestration position", () => {
  const config = {
    containers: {
      nginx: { enabled: true, monitor: true, startupOrder: 20 },
      sonarr: { enabled: false, monitor: true, startupOrder: 10 },
      postgres: { enabled: true, monitor: false, startupOrder: 30 },
    },
  };

  assert.equal(positionInMode("nginx", containers, config, "orchestration"), 1);
  assert.equal(positionInMode("postgres", containers, config, "orchestration"), 2);
});

test("nextSelectionOrder appends to the selected set instead of using unselected card order", () => {
  const config = {
    containers: {
      unselectedEarly: { enabled: false, monitor: false, startupOrder: 1, monitorOrder: 1 },
      nginx: { enabled: true, monitor: true, startupOrder: 10, monitorOrder: 30 },
      sonarr: { enabled: true, monitor: true, startupOrder: 20, monitorOrder: 10 },
      guardOnly: { enabled: false, monitor: true, startupOrder: 5, monitorOrder: 20 },
    },
  };

  assert.equal(nextSelectionOrder(config, "orchestration"), 30);
  assert.equal(nextSelectionOrder(config, "guard"), 40);
});

test("reorderModeConfig selects dragged card and moves it before target", () => {
  const config = {
    containers: {
      nginx: { name: "nginx", enabled: true, monitor: true, startupOrder: 10 },
      sonarr: { name: "sonarr", enabled: true, monitor: true, startupOrder: 20 },
      postgres: { name: "postgres", enabled: false, monitor: false, startupOrder: 30 },
    },
  };

  const next = reorderModeConfig({
    config,
    containers,
    mode: "orchestration",
    draggedId: "postgres",
    targetId: "nginx",
  });

  assert.equal(next.containers.postgres.enabled, true);
  assert.equal(next.containers.postgres.startupOrder, 10);
  assert.equal(next.containers.nginx.startupOrder, 20);
  assert.equal(next.containers.sonarr.startupOrder, 30);
});

test("reorderModeConfig appends when dropped on empty grid space", () => {
  const config = {
    containers: {
      nginx: { name: "nginx", enabled: true, startupOrder: 10 },
      sonarr: { name: "sonarr", enabled: true, startupOrder: 20 },
      postgres: { name: "postgres", enabled: false, startupOrder: 30 },
    },
  };

  const next = reorderModeConfig({
    config,
    containers,
    mode: "orchestration",
    draggedId: "postgres",
  });

  assert.equal(next.containers.postgres.enabled, true);
  assert.equal(next.containers.nginx.startupOrder, 10);
  assert.equal(next.containers.sonarr.startupOrder, 20);
  assert.equal(next.containers.postgres.startupOrder, 30);
});

test("reorderModeConfig does not reorder guard mode", () => {
  const config = {
    containers: {
      nginx: { name: "nginx", monitor: true, startupOrder: 10 },
      sonarr: { name: "sonarr", monitor: false, startupOrder: 20 },
    },
  };

  assert.equal(
    reorderModeConfig({
      config,
      containers,
      mode: "guard",
      draggedId: "sonarr",
      targetId: "nginx",
    }),
    config,
  );
});

test("reorderModeConfig keeps startupOrder unique across containers outside the active mode", () => {
  const config = {
    containers: {
      nginx: { name: "nginx", enabled: true, monitor: true, startupOrder: 10 },
      moviepilot: { name: "moviepilot", enabled: true, monitor: true, startupOrder: 20 },
      symedia: { name: "symedia", enabled: true, monitor: false, startupOrder: 30 },
      sonarr: { name: "sonarr", enabled: false, monitor: true, startupOrder: 40 },
      filebrowser: { name: "filebrowser", enabled: false, monitor: false, startupOrder: 50 },
    },
  };

  const next = reorderModeConfig({
    config,
    containers: [
      ...containers,
      { id: "moviepilot", name: "moviepilot" },
      { id: "symedia", name: "symedia" },
      { id: "filebrowser", name: "filebrowser" },
    ],
    mode: "orchestration",
    draggedId: "filebrowser",
    targetId: "nginx",
  });

  const orders = Object.values(next.containers).map((item) => item.startupOrder);
  assert.deepEqual(orders, [20, 30, 40, 50, 10]);
  assert.equal(new Set(orders).size, orders.length);
});
