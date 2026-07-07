import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONTAINER_CONFIG, DEFAULT_SETTINGS, LIMITS } from "../shared/defaults.js";

export function clampInteger(value, fallback, limit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  return Math.min(limit.max, Math.max(limit.min, integer));
}

export function normalizeConfig(input = {}) {
  const settings = input.settings || {};
  const containers = input.containers || {};
  const normalized = {
    version: 1,
    settings: {
      checkIntervalSeconds: clampInteger(
        settings.checkIntervalSeconds,
        DEFAULT_SETTINGS.checkIntervalSeconds,
        LIMITS.checkIntervalSeconds,
      ),
      startupRetryDelaySeconds: clampInteger(
        settings.startupRetryDelaySeconds,
        DEFAULT_SETTINGS.startupRetryDelaySeconds,
        LIMITS.startupRetryDelaySeconds,
      ),
      startupTimeoutSeconds: clampInteger(
        settings.startupTimeoutSeconds,
        DEFAULT_SETTINGS.startupTimeoutSeconds,
        LIMITS.startupTimeoutSeconds,
      ),
    },
    containers: {},
  };

  for (const [id, container] of Object.entries(containers)) {
    if (!id || typeof container !== "object" || container === null) continue;
    normalized.containers[id] = {
      enabled: container.enabled === true,
      startupOrder: clampInteger(
        container.startupOrder,
        DEFAULT_CONTAINER_CONFIG.startupOrder,
        LIMITS.startupOrder,
      ),
      startupDelaySeconds: clampInteger(
        container.startupDelaySeconds,
        DEFAULT_CONTAINER_CONFIG.startupDelaySeconds,
        LIMITS.startupDelaySeconds,
      ),
      monitor: container.monitor === true,
      monitorOrder: clampInteger(
        container.monitorOrder ?? container.startupOrder,
        DEFAULT_CONTAINER_CONFIG.monitorOrder,
        LIMITS.monitorOrder,
      ),
    };
  }

  return normalized;
}

export class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async read() {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      return normalizeConfig(JSON.parse(text));
    } catch (error) {
      if (error.code === "ENOENT") {
        const config = normalizeConfig();
        await this.write(config);
        return config;
      }
      if (error instanceof SyntaxError) {
        const config = normalizeConfig();
        await this.write(config);
        return config;
      }
      throw error;
    }
  }

  async write(config) {
    const normalized = normalizeConfig(config);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }
}

export function mergeDiscoveredContainers(config, containers) {
  const next = normalizeConfig(config);
  const discoveredIds = new Set(containers.map((container) => container.id));
  const retained = Object.fromEntries(Object.entries(next.containers).filter(([id]) => discoveredIds.has(id)));
  const existingOrders = Object.values(retained).map((item) => item.startupOrder);
  let nextOrder = existingOrders.length > 0 ? Math.max(...existingOrders) + 10 : 10;
  next.containers = {};

  for (const container of containers) {
    if (!retained[container.id]) {
      next.containers[container.id] = {
        ...DEFAULT_CONTAINER_CONFIG,
        startupOrder: nextOrder,
        monitorOrder: nextOrder,
      };
      nextOrder += 10;
    } else {
      next.containers[container.id] = retained[container.id];
    }
  }

  return next;
}
