function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sortConfiguredContainers(config) {
  return Object.entries(config.containers || {})
    .filter(([, item]) => item.enabled === true)
    .sort((a, b) => {
      const orderDelta = a[1].startupOrder - b[1].startupOrder;
      if (orderDelta !== 0) return orderDelta;
      return a[0].localeCompare(b[0]);
    })
    .map(([id, item]) => ({ id, ...item }));
}

export function sortMonitoredContainers(config) {
  return Object.entries(config.containers || {})
    .filter(([, item]) => item.monitor === true)
    .sort((a, b) => {
      const orderDelta = a[1].startupOrder - b[1].startupOrder;
      if (orderDelta !== 0) return orderDelta;
      return a[0].localeCompare(b[0]);
    })
    .map(([id, item]) => ({ id, ...item }));
}

export function isReady(container) {
  if (!container?.running && container?.state !== "running") return false;
  if (container.health && container.health !== "none") return container.health === "healthy";
  return true;
}

export class StartupEngine {
  constructor({ docker, log, sleepFn = sleep } = {}) {
    this.docker = docker;
    this.log = log;
    this.sleep = sleepFn;
    this.running = false;
  }

  async runOrderedStartup(config, { monitorOnly = false } = {}) {
    if (this.running) {
      return { status: "busy" };
    }
    this.running = true;
    const settings = config.settings;
    const ordered = monitorOnly ? sortMonitoredContainers(config) : sortConfiguredContainers(config);
    const results = [];

    try {
      for (const item of ordered) {
        const result = await this.ensureContainerReady(item.id, item, settings);
        results.push(result);
        if (result.status !== "ready") {
          break;
        }
        if (item.startupDelaySeconds > 0) {
          await this.sleep(item.startupDelaySeconds * 1000);
        }
      }
      return { status: "ok", results };
    } finally {
      this.running = false;
    }
  }

  async ensureContainerReady(id, item, settings) {
    const startedAt = Date.now();
    const timeoutMs = settings.startupTimeoutSeconds * 1000;
    let attempts = 0;

    while (Date.now() - startedAt <= timeoutMs) {
      attempts += 1;
      const current = await this.docker.inspectContainer(id);
      if (isReady(current)) {
        await this.log?.append("status_check", `${current.name} is ready`, { id, attempts });
        return { id, name: current.name, status: "ready", attempts };
      }
      if (!current.running) {
        await this.log?.append("startup", `Starting ${current.name}`, { id, attempts });
        await this.docker.startContainer(id);
      } else {
        await this.log?.append("status_check", `${current.name} is ${current.health}`, { id, attempts });
      }
      await this.sleep(settings.startupRetryDelaySeconds * 1000);
    }

    await this.log?.append("error", `Startup timeout for ${id}`, { id, order: item.startupOrder });
    return { id, status: "timeout", attempts };
  }
}
