import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { LAUNCH_ID } from "../shared/defaults.js";

const root = path.resolve(import.meta.dirname, "../..");

test("fnOS icon contract uses the canonical desktop launcher id", () => {
  const manifest = fs.readFileSync(path.join(root, "packaging", "fnos", "manifest"), "utf8");
  const uiConfig = JSON.parse(fs.readFileSync(path.join(root, "packaging", "fnos", "app", "ui", "config"), "utf8"));
  const iconSync = fs.readFileSync(path.join(root, "packaging", "fnos", "cmd", "icon_sync"), "utf8");

  assert.match(manifest, /desktop_applaunchname = dockerstart\.Application/);
  assert.doesNotMatch(manifest, /dockerstart\.Manager/);
  assert.equal(LAUNCH_ID, "dockerstart.Application");

  const entry = uiConfig[".url"]?.["dockerstart.Application"];
  assert.ok(entry, "ui/config must expose dockerstart.Application");
  assert.equal(entry.icon, "images/docker-manager-3d_{0}.png");
  assert.equal(uiConfig[".url"]?.["dockerstart.Manager"], undefined);

  assert.match(iconSync, /sync_cached_icon_files\(\)/);
  assert.match(iconSync, /\/vol\*\/appcenter-downloads/);
  assert.match(iconSync, /dockerstart\.Application/);
  assert.match(iconSync, /dockermanager\.Application/);
  assert.match(iconSync, /dockermanager\.Manager/);
});
