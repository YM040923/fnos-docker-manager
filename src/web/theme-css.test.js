import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const themeCss = fs.readFileSync(new URL("./theme.css", import.meta.url), "utf8");

function blockFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = themeCss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] || "";
}

test("theme uses a quiet neutral palette", () => {
  assert.doesNotMatch(themeCss, /#16a34a|#dc2626|#c08400|#7c3aed|#0f766e/i);
  assert.match(themeCss, /--bg:\s*#f3f4f6;/);
  assert.match(blockFor(".main"), /background:\s*var\(--bg\);/);
});

test("sidebar blends into the app without a divider line", () => {
  const sidebar = blockFor(".sidebar");
  assert.match(sidebar, /background:\s*#fff;/);
  assert.match(sidebar, /border-right:\s*0;/);
});

test("selected cards stay visually restrained", () => {
  const selected = blockFor('.select-card[data-selected="true"]');
  assert.match(selected, /background:\s*var\(--selected-bg\);/);
  assert.doesNotMatch(selected, /box-shadow:\s*inset 0 0 0 1px/);
});
