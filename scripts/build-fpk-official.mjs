import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const fnpack = process.env.FNPACK_EXE || path.join(root, "tools", "fnpack-user.exe");
const sourceDir = path.join(root, "dist", "fnos", "fnpack-src");
const outDir = path.join(root, "dist", "fnos");
const officialFile = path.join(outDir, `DockerStart-${pkg.version}-fnpack-raw-x86_64.fpk`);
const finalFile = path.join(outDir, `DockerStart-${pkg.version}-fnpack-fixed-x86_64.fpk`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

if (!fs.existsSync(fnpack)) {
  throw new Error(`Missing official fnpack tool: ${fnpack}`);
}

run(process.execPath, [path.join(root, "scripts", "prepare-runtime-native.mjs")]);
run(process.execPath, [path.join(root, "scripts", "prepare-fnpack-source.mjs")]);
run(fnpack, ["build", "-d", sourceDir]);

const built = [sourceDir, root]
  .flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".fpk"))
      .map((name) => path.join(dir, name)),
  )
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

if (!built) throw new Error(`fnpack did not create an fpk in ${sourceDir}`);
fs.copyFileSync(built, officialFile);
run(process.execPath, [path.join(root, "scripts", "fix-fpk-modes.mjs"), officialFile, finalFile]);
console.log(`Built official fnpack package at ${finalFile}`);
