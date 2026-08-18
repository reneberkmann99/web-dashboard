import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    setupFiles: ["tests/setup.ts"]
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname)
    }
  }
});
