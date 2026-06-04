import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, createHandler } from "./http-app.js";
import { GATEWAY_PREFIX, GATEWAY_SOCKET } from "../shared/defaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDest = process.env.TRIM_APPDEST || path.resolve(__dirname, "../..");
const pkgVar = process.env.TRIM_PKGVAR || path.resolve(appDest, ".data");
const socketPath = process.env.FNOS_SOCKET_PATH || path.join(appDest, GATEWAY_SOCKET);
const webDir = process.env.FNOS_WEB_DIR || path.resolve(__dirname, "../../src/web");
const basePath = process.env.FNOS_GATEWAY_PREFIX || GATEWAY_PREFIX;

await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
try {
  fs.unlinkSync(socketPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const server = http.createServer(
  createHandler(
    createContext({
      dataDir: pkgVar,
      webDir,
      basePath,
    }),
  ),
);

server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o660);
  console.log(`Docker Manager listening on ${socketPath}`);
});

function shutdown() {
  server.close(() => {
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

