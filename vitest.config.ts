import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@/": `${resolve(process.cwd())}/`, "@": resolve(process.cwd()) } },
  test: {
    environment: "node",
    fileParallelism: false,
  },
});
