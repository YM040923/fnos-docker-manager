import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path) {
  return fs.readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("Docker delivery files expose Docker socket, data volume, and web port", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("docker-compose.yml");

  assert.match(dockerfile, /EXPOSE 13000/);
  assert.match(dockerfile, /APP_LISTEN_ADDR=0\.0\.0\.0:13000/);
  assert.match(dockerfile, /TRIM_PKGVAR=\/data/);
  assert.match(compose, /ghcr\.io\/ym040923\/fnos-docker-manager/);
  assert.match(compose, /13000:13000/);
  assert.match(compose, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(compose, /dockerstart_data:\/data/);
});

test("GitHub Actions publishes container image to GHCR", () => {
  const workflow = read(".github/workflows/container.yml");

  assert.match(workflow, /ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/fnos-docker-manager/);
  assert.match(workflow, /docker\/build-push-action/);
  assert.match(workflow, /push: true/);
  assert.match(workflow, /type=raw,value=latest/);
});
