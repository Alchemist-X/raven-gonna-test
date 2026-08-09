import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@raven-gonna-test/forecast-core": `${root}packages/forecast-core/src/index.ts`,
      "@raven-gonna-test/runtime": `${root}packages/runtime/src/index.ts`,
      "@raven-gonna-test/benchmarks": `${root}packages/benchmarks/src/index.ts`,
      "@raven-gonna-test/eval": `${root}packages/eval/src/index.ts`
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"]
    }
  }
});

