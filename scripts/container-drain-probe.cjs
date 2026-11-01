// Runs against compiled modules inside either image (and a local API build).
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createServerLifecycle, installShutdownSignalHandlers, SERVER_SHUTDOWN_TIMEOUT_MS } = require(`${process.cwd()}/dist/server.js`);
const { getCached, destroyCache } = require(`${process.cwd()}/dist/sources/upstream/cache.js`);

async function probe() {
  assert.equal(SERVER_SHUTDOWN_TIMEOUT_MS, 10_000);
  let cleanups = 0;
  const cacheWork = getCached("drain-probe", () => new Promise(() => {}), 60_000).catch(() => {});
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("started");
    setTimeout(() => response.end("completed"), 200);
  });
  const lifecycle = createServerLifecycle({ server, cleanup: () => { cleanups++; destroyCache(); }, logger: () => {} });
  const detach = installShutdownSignalHandlers(lifecycle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const body = await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${server.address().port}/slow`, (response) => {
      let text = "";
      response.once("data", () => {
        process.kill(process.pid, "SIGTERM");
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 25);
      });
      response.on("data", (chunk) => { text += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve(text));
    });
    request.once("error", reject);
  });
  assert.equal(body, "startedcompleted");
  await lifecycle.shutdown("SIGINT");
  await cacheWork;
  detach();
  assert.equal(cleanups, 1);

  let received;
  const accepted = new Promise((resolve) => { received = resolve; });
  const stalled = http.createServer(() => received());
  const deadline = createServerLifecycle({ server: stalled, cleanup: () => { cleanups++; }, shutdownTimeoutMs: 100, logger: () => {} });
  stalled.listen(0, "127.0.0.1");
  await once(stalled, "listening");
  const closed = new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${stalled.address().port}/stalled`, () => reject(new Error("Stalled request unexpectedly completed")));
    request.once("error", resolve);
  });
  await accepted;
  await deadline.shutdown("SIGTERM");
  await closed;
  assert.equal(cleanups, 2);
  process.stdout.write("OK: repeated process signals drain active requests; deadline closes stalled sockets\n");
}

probe().catch((error) => { console.error(error); destroyCache(); process.exitCode = 1; });
