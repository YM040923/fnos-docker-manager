import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function readScript(name) {
  return fs.readFileSync(path.join(root, "packaging", "fnos", "cmd", name), "utf8");
}

test("fnOS lifecycle scripts register the background service for boot startup", () => {
  const main = readScript("main");
  const installCallback = readScript("install_callback");
  const upgradeCallback = readScript("upgrade_callback");
  const uninstallInit = readScript("uninstall_init");

  assert.match(main, /install_autostart\(\)/);
  assert.match(main, /remove_autostart\(\)/);
  assert.match(main, /WantedBy=multi-user\.target/);
  assert.match(main, /After=network-online\.target docker\.service/);
  assert.match(main, /systemctl enable "\$SERVICE_NAME"/);
  assert.match(main, /TRIM_TEMP_LOGFILE/);
  assert.doesNotMatch(main, /systemctl enable "\$SERVICE_NAME" \|\| true/);

  assert.match(installCallback, /\/main" install-autostart/);
  assert.match(installCallback, /\/main" start/);
  assert.match(upgradeCallback, /\/main" install-autostart/);
  assert.match(uninstallInit, /\/main" remove-autostart/);
  assert.match(uninstallInit, /\/main" stop/);
});
