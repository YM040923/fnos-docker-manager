import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const fnpack = path.join(root, "tools", "fnpack-user.exe");
const dist = path.join(root, "dist", "fnos");
const baseSource = path.join(dist, "fnpack-src");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.replace(/\r?\n/g, "\n"), "utf8");
}

function packageVariant(name, mutate) {
  const src = path.join(dist, `diag-${name}`);
  reset(src);
  copyDir(baseSource, src);
  mutate(src);
  run(fnpack, ["build", "-d", src]);
  const raw = path.join(root, "dockermanager.fpk");
  const rawOut = path.join(dist, `DockerManager-diag-${name}-raw.fpk`);
  const fixedOut = path.join(dist, `DockerManager-diag-${name}-fixed.fpk`);
  fs.copyFileSync(raw, rawOut);
  run(process.execPath, [path.join(root, "scripts", "fix-fpk-modes.mjs"), rawOut, fixedOut]);
  console.log(`Diagnostic package: ${fixedOut}`);
}

run(process.execPath, [path.join(root, "scripts", "prepare-runtime-native.mjs")]);
run(process.execPath, [path.join(root, "scripts", "prepare-fnpack-source.mjs")]);

packageVariant("url", (src) => {
  write(
    path.join(src, "app", "ui", "config"),
    JSON.stringify(
      {
        ".url": {
          "dockermanager.Application": {
            title: "Docker Manager",
            desc: "Docker container startup order and monitoring manager",
            icon: "images/icon_{0}.png",
            type: "url",
            protocol: "",
            port: "8080",
            url: "/",
            allUsers: false,
          },
        },
      },
      null,
      2,
    ),
  );
});

packageVariant("stub-gateway", (src) => {
  write(
    path.join(src, "app", "bin", "docker-manager"),
    `#!/bin/sh
while true; do sleep 3600; done
`,
  );
  fs.rmSync(path.join(src, "app", "config", "env.example"), { force: true });
});

packageVariant("stub-url", (src) => {
  write(
    path.join(src, "app", "bin", "docker-manager"),
    `#!/bin/sh
while true; do sleep 3600; done
`,
  );
  fs.rmSync(path.join(src, "app", "config", "env.example"), { force: true });
  write(
    path.join(src, "app", "ui", "config"),
    JSON.stringify(
      {
        ".url": {
          "dockermanager.Application": {
            title: "Docker Manager",
            desc: "Docker container startup order and monitoring manager",
            icon: "images/icon_{0}.png",
            type: "url",
            protocol: "",
            port: "8080",
            url: "/",
            allUsers: false,
          },
        },
      },
      null,
      2,
    ),
  );
});
