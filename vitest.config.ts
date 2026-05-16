import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", ".next", "dist"],
    /** Smoke tests today are pure logic — no DB / network. If a test
     *  needs Supabase or HTTP, mock at the lib boundary. */
    testTimeout: 5000,
  },
});
