import assert from "node:assert/strict";
import test from "node:test";
import { StartupEngine, isReady, sortConfiguredContainers } from "./startup-engine.js";

test("sortConfiguredContainers uses ascending order then id", () => {
  const ordered = sortConfiguredContainers({
    containers: {
      b: { enabled: true, startupOrder: 20 },
      c: { enabled: false, startupOrder: 1 },
      a: { enabled: true, startupOrder: 20 },
      first: { enabled: true, startupOrder: 1 },
    },
  });

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["first", "a", "b"],
  );
});

test("monitor-only startup uses guarded containers even when they are not in startup plan", async () => {
  const actions = [];
  const docker = {
    async inspectContainer(id) {
      actions.push(`inspect:${id}`);
      return { id, name: id, running: true, health: "none" };
    },
    async startContainer(id) {
      actions.push(`start:${id}`);
    },
  };
  const log = { async append() {} };
  const engine = new StartupEngine({ docker, log, sleepFn: async () => {} });

  const result = await engine.runOrderedStartup(
    {
      settings: {
        startupTimeoutSeconds: 1,
        startupRetryDelaySeconds: 1,
      },
      containers: {
        startupOnly: { enabled: true, monitor: false, startupOrder: 1, startupDelaySeconds: 0 },
        guardOnly: { enabled: false, monitor: true, startupOrder: 2, startupDelaySeconds: 0 },
        unmanaged: { enabled: false, monitor: false, startupOrder: 3, startupDelaySeconds: 0 },
      },
    },
    { monitorOnly: true },
  );

  assert.deepEqual(
    result.results.map((item) => item.id),
    ["guardOnly"],
  );
  assert.deepEqual(actions, ["inspect:guardOnly"]);
});

test("isReady requires healthy when Docker health exists", () => {
  assert.equal(isReady({ running: true, health: "healthy" }), true);
  assert.equal(isReady({ running: true, health: "unhealthy" }), false);
  assert.equal(isReady({ running: true, health: "none" }), true);
  assert.equal(isReady({ running: false, health: "healthy" }), false);
});

test("runOrderedStartup stops at first unresolved dependency", async () => {
  const actions = [];
  const docker = {
    async inspectContainer(id) {
      actions.push(`inspect:${id}`);
      return { id, name: id, running: false, health: "none" };
    },
    async startContainer(id) {
      actions.push(`start:${id}`);
    },
  };
  const log = { async append() {} };
  const engine = new StartupEngine({ docker, log, sleepFn: async () => {} });
  const result = await engine.runOrderedStartup({
    settings: {
      startupTimeoutSeconds: 0,
      startupRetryDelaySeconds: 1,
    },
    containers: {
      first: { enabled: true, startupOrder: 1, startupDelaySeconds: 0, monitor: true },
      second: { enabled: true, startupOrder: 2, startupDelaySeconds: 0, monitor: true },
    },
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, "first");
  assert.equal(result.results[0].status, "timeout");
  assert.ok(actions.includes("inspect:first"));
  assert.ok(actions.includes("start:first"));
  assert.equal(actions.some((action) => action.includes("second")), false);
});
