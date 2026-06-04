import fs from "node:fs/promises";
import path from "node:path";
import { ConfigStore, mergeDiscoveredContainers } from "./config-store.js";
import { ActivityLog } from "./activity-log.js";
import { DockerClient, DockerUnavailableError } from "./docker-client.js";
import { StartupEngine } from "./startup-engine.js";
import { GATEWAY_PREFIX } from "../shared/defaults.js";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export function createContext(options = {}) {
  const dataDir = options.dataDir || process.env.FNOS_DATA_DIR || process.env.TRIM_PKGVAR || path.resolve(".data");
  const webDir = options.webDir || process.env.FNOS_WEB_DIR || path.resolve("src/web");
  const configStore = options.configStore || new ConfigStore(path.join(dataDir, "config.json"));
  const activityLog = options.activityLog || new ActivityLog(path.join(dataDir, "logs", "activity.log"));
  const docker = options.docker || new DockerClient(options.dockerSocket || process.env.DOCKER_SOCKET || "/var/run/docker.sock");
  const engine = options.engine || new StartupEngine({ docker, log: activityLog });
  return {
    basePath: options.basePath || process.env.FNOS_GATEWAY_PREFIX || GATEWAY_PREFIX,
    webDir,
    configStore,
    activityLog,
    docker,
    engine,
    monitorTimer: null,
  };
}

export function createHandler(context = createContext()) {
  return async function handler(request, response) {
    try {
      const url = new URL(request.url || "/", "http://unix");
      const pathname = stripBasePath(url.pathname, context.basePath);
      if (pathname.startsWith("/api/")) {
        await handleApi(context, request, response, pathname);
        return;
      }
      await serveStatic(context.webDir, pathname, response);
    } catch (error) {
      sendError(response, error);
    }
  };
}

export function stripBasePath(pathname, basePath) {
  if (basePath && pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  if (basePath && pathname === basePath) return "/";
  return pathname;
}

async function handleApi(context, request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/config") {
    sendJson(response, await context.configStore.read());
    return;
  }

  if (request.method === "PUT" && pathname === "/api/config") {
    const body = await readJsonBody(request);
    const saved = await context.configStore.write(body);
    await context.activityLog.append("config", "Configuration saved");
    sendJson(response, saved);
    return;
  }

  if (request.method === "GET" && pathname === "/api/containers") {
    await sendContainers(context, response);
    return;
  }

  if (request.method === "POST" && pathname === "/api/actions/refresh") {
    const config = await context.configStore.read();
    const containers = await context.docker.listContainers();
    const merged = mergeDiscoveredContainers(config, containers);
    await context.configStore.write(merged);
    await context.activityLog.append("refresh", "Container discovery refreshed", { count: containers.length });
    sendJson(response, { containers, config: merged });
    return;
  }

  if (request.method === "POST" && pathname === "/api/actions/startup-run") {
    const result = await context.engine.runOrderedStartup(await context.configStore.read());
    sendJson(response, result);
    return;
  }

  if (request.method === "GET" && pathname === "/api/logs") {
    sendJson(response, await context.activityLog.recent());
    return;
  }

  const actionMatch = pathname.match(/^\/api\/containers\/([^/]+)\/(start|stop|restart)$/);
  if (request.method === "POST" && actionMatch) {
    const id = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    if (action === "start") await context.docker.startContainer(id);
    if (action === "stop") await context.docker.stopContainer(id);
    if (action === "restart") await context.docker.restartContainer(id);
    await context.activityLog.append(action, `${action} requested`, { id });
    sendJson(response, { ok: true });
    return;
  }

  sendJson(response, { error: { code: "NOT_FOUND", message: "API route not found" } }, 404);
}

async function sendContainers(context, response) {
  const config = await context.configStore.read();
  const containers = await context.docker.listContainers();
  const merged = mergeDiscoveredContainers(config, containers);
  if (JSON.stringify(merged.containers) !== JSON.stringify(config.containers)) {
    await context.configStore.write(merged);
  }
  sendJson(response, { containers, config: merged });
}

async function serveStatic(webDir, pathname, response) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(webDir, `.${safePath}`);
  if (!resolved.startsWith(path.resolve(webDir))) {
    sendJson(response, { error: { code: "BAD_PATH", message: "Invalid path" } }, 400);
    return;
  }

  try {
    const file = await fs.readFile(resolved);
    response.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(resolved)] || "application/octet-stream" });
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      const index = await fs.readFile(path.join(webDir, "index.html"));
      response.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
      response.end(index);
      return;
    }
    throw error;
  }
}

async function readJsonBody(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 1024 * 1024) throw new Error("Request body too large");
  }
  return text ? JSON.parse(text) : {};
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendError(response, error) {
  if (error instanceof DockerUnavailableError) {
    sendJson(response, { error: { code: error.code, message: error.message } }, 503);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, { error: { code: "INTERNAL_ERROR", message } }, 500);
}

