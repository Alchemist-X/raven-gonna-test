import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "coverage", "runtime-artifacts"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target));
    else files.push(target);
  }
  return files;
}

const errors = [];
const coreRoot = path.join(root, "packages/forecast-core/src");
for (const file of await filesUnder(coreRoot)) {
  if (!file.endsWith(".ts")) continue;
  const source = await readFile(file, "utf8");
  const relative = path.relative(root, file);
  const forbidden = [
    ["process.env", "core must not read environment variables"],
    ["node:fs", "core must not access the filesystem"],
    ["node:http", "core must not host HTTP"],
    ["node:https", "core must not use HTTPS"],
    ["node:net", "core must not use sockets"],
    ["node:tls", "core must not use TLS sockets"],
    ["undici", "core must not import an HTTP client"],
    ["@raven-gonna-test/runtime", "core must not import runtime"],
    ["@raven-gonna-test/benchmarks", "core must not import benchmark adapters"],
    ["FORECAST_MARKET_BLIND", "core policy must be explicit per job"]
  ];
  for (const [needle, message] of forbidden) {
    if (source.includes(needle)) errors.push(`${relative}: ${message} (${needle})`);
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const inspect = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
      errors.push(`${relative}: core must not call fetch()`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["WebSocket", "XMLHttpRequest"].includes(node.expression.text)) {
      errors.push(`${relative}: core must not create ${node.expression.text}`);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(tree);
}

const dependencyAllowlists = new Map([
  ["@raven-gonna-test/forecast-core", new Set(["zod"])],
  ["@raven-gonna-test/runtime", new Set(["@raven-gonna-test/forecast-core", "zod"])],
  ["@raven-gonna-test/benchmarks", new Set(["@raven-gonna-test/forecast-core", "hyparquet", "zod"])],
  ["@raven-gonna-test/eval", new Set(["@raven-gonna-test/forecast-core", "@raven-gonna-test/benchmarks", "zod"])],
  ["@raven-gonna-test/benchmark-cli", new Set(["@raven-gonna-test/forecast-core", "@raven-gonna-test/benchmarks", "@raven-gonna-test/runtime", "@raven-gonna-test/eval"])],
  ["@raven-gonna-test/prophet-arena-api", new Set(["@raven-gonna-test/forecast-core", "@raven-gonna-test/benchmarks", "@raven-gonna-test/runtime", "zod"])]
]);

for (const packageFile of (await filesUnder(root)).filter((file) => file.endsWith("package.json") && !file.includes("node_modules"))) {
  const manifest = JSON.parse(await readFile(packageFile, "utf8"));
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  for (const banned of ["ethers", "viem", "@polymarket", "@kalshi"]) {
    if (Object.keys(dependencies).some((name) => name === banned || name.startsWith(`${banned}/`))) {
      errors.push(`${path.relative(root, packageFile)}: banned trading dependency ${banned}`);
    }
  }
  const allowlist = dependencyAllowlists.get(manifest.name);
  if (allowlist) {
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!allowlist.has(dependency)) errors.push(`${path.relative(root, packageFile)}: dependency ${dependency} is not boundary-approved`);
    }
  }
}

for (const directory of ["packages", "apps"]) {
  for (const file of await filesUnder(path.join(root, directory))) {
    if (!file.endsWith(".ts")) continue;
    const source = await readFile(file, "utf8");
    for (const forbidden of [
      "@autopoly/",
      "forecast:live",
      "PRIVATE_KEY",
      "WALLET_",
      "clob.polymarket.com",
      "trading-api.kalshi.com",
      "createOrder",
      "placeOrder",
      "nodemailer",
      "@google-cloud/storage"
    ]) {
      if (source.includes(forbidden)) errors.push(`${path.relative(root, file)}: forbidden trading coupling ${forbidden}`);
    }
  }
}

if (errors.length) {
  process.stderr.write(`${errors.map((error) => `[ERR] ${error}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("[OK] dependency and trading-boundary checks passed\n");
