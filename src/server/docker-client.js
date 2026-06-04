import http from "node:http";

export class DockerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "DockerUnavailableError";
    this.code = "DOCKER_UNAVAILABLE";
  }
}

function dockerRequest(socketPath, method, requestPath, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: requestPath,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode || 500;
          const data = text ? JSON.parse(text) : null;
          if (status >= 400) {
            const message = data?.message || `Docker API returned HTTP ${status}`;
            reject(new Error(message));
            return;
          }
          resolve(data);
        });
      },
    );

    request.on("error", (error) => {
      reject(new DockerUnavailableError(`Cannot access Docker socket ${socketPath}: ${error.message}`));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

export class DockerClient {
  constructor(socketPath = "/var/run/docker.sock") {
    this.socketPath = socketPath;
  }

  async listContainers() {
    const rows = await dockerRequest(this.socketPath, "GET", "/containers/json?all=1");
    return rows.map((row) => normalizeContainer(row));
  }

  async inspectContainer(id) {
    const row = await dockerRequest(this.socketPath, "GET", `/containers/${encodeURIComponent(id)}/json`);
    return normalizeInspect(row);
  }

  async startContainer(id) {
    await dockerRequest(this.socketPath, "POST", `/containers/${encodeURIComponent(id)}/start`);
  }

  async stopContainer(id) {
    await dockerRequest(this.socketPath, "POST", `/containers/${encodeURIComponent(id)}/stop`);
  }

  async restartContainer(id) {
    await dockerRequest(this.socketPath, "POST", `/containers/${encodeURIComponent(id)}/restart`);
  }
}

export function normalizeContainer(row) {
  const name = Array.isArray(row.Names) && row.Names.length > 0 ? row.Names[0].replace(/^\//, "") : row.Id.slice(0, 12);
  return {
    id: row.Id,
    name,
    image: row.Image || "",
    state: row.State || "unknown",
    status: row.Status || "",
    health: row.Health?.Status || row.State?.Health?.Status || "none",
    ports: row.Ports || [],
  };
}

export function normalizeInspect(row) {
  const name = row.Name ? row.Name.replace(/^\//, "") : row.Id.slice(0, 12);
  return {
    id: row.Id,
    name,
    image: row.Config?.Image || "",
    state: row.State?.Status || "unknown",
    running: Boolean(row.State?.Running),
    health: row.State?.Health?.Status || "none",
  };
}

