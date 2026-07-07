import assert from "node:assert/strict";
import test from "node:test";
import { setGuardParticipation, setStartupParticipation } from "./container-policy.js";

test("startup participation toggles only startup membership", () => {
  const current = { enabled: false, monitor: true, startupOrder: 30, startupDelaySeconds: 12, name: "nginx" };

  assert.deepEqual(setStartupParticipation(current, true), {
    enabled: true,
    monitor: true,
    startupOrder: 30,
    startupDelaySeconds: 12,
    name: "nginx",
  });

  assert.deepEqual(setStartupParticipation({ monitor: false }, true), { enabled: true, monitor: false });
  assert.deepEqual(setStartupParticipation({ enabled: true, monitor: true }, false), { enabled: false, monitor: true });
});

test("guard participation toggles only guard membership", () => {
  assert.deepEqual(setGuardParticipation({ enabled: true, monitor: false }, true), { enabled: true, monitor: true });
  assert.deepEqual(setGuardParticipation({ enabled: true, monitor: true }, false), { enabled: true, monitor: false });
  assert.deepEqual(setGuardParticipation({}, true), { enabled: false, monitor: true });
});
