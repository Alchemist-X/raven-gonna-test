#!/usr/bin/env node
import { createProphetServer, listen, loadProphetServerConfig } from "./server.js";

const config = loadProphetServerConfig();
process.stderr.write("[INFO] execution mode: benchmark-service; decision source: explicit Prophet requests; trading disabled\n");
const server = createProphetServer(config);
const address = await listen(server, config);
process.stderr.write(`[OK] Prophet Arena endpoint listening on http://${address.address}:${address.port}/forecast\n`);
process.stderr.write(`[INFO] artifacts: ${config.artifactRoot}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.stderr.write(`[INFO] received ${signal}; draining server\n`);
    server.close((error) => {
      if (error) process.stderr.write(`[ERR] ${error.message}\n`);
      process.exit(error ? 1 : 0);
    });
  });
}

