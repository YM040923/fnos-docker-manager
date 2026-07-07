import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore, mergeDiscoveredContainers, normalizeConfig } from "./config-store.js";

test("normalizeConfig clamps invalid settings and container values", () => {
  const config = normalizeConfig({
    settings: {
      checkIntervalSeconds: 1,
      startupRetryDelaySeconds: 99999,
      startupTimeoutSeconds: "bad",
    },
    containers: {
      abc: {
        enabled: false,
        startupOrder: -50,
        startupDelaySeconds: 99999,
        monitor: false,
      },
    },
  });

  assert.equal(config.settings.checkIntervalSeconds, 10);
  assert.equal(config.settings.startupRetryDelaySeconds, 600);
  assert.equal(config.settings.startupTimeoutSeconds, 120);
  assert.equal(config.containers.abc.enabled, false);
  assert.equal(config.containers.abc.startupOrder, 0);
  assert.equal(config.containers.abc.startupDelaySeconds, 3600);
  assert.equal(config.containers.abc.monitor, false);
});

test("ConfigStore creates a default config when missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fdm-config-"));
  const store = new ConfigStore(path.join(dir, "config.json"));
  const config = await store.read();

  assert.equal(config.version, 1);
  assert.equal(config.settings.checkIntervalSeconds, 60);
});

test("mergeDiscoveredContainers prunes stale config and assigns new startup orders", () => {
  const config = mergeDiscoveredContainers(
    {
      version: 1,
      settings: {},
      containers: {
        old: { startupOrder: 20, enabled: true, startupDelaySeconds: 0, monitor: true },
      },
    },
    [{ id: "new", name: "new" }],
  );

  assert.equal(config.containers.old, undefined);
  assert.equal(config.containers.new.startupOrder, 10);
  assert.equal(config.containers.new.enabled, false);
  assert.equal(config.containers.new.monitor, false);
});
