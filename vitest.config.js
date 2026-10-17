import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.js", "tests/integration/**/*.test.js"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{js,mjs}"],
      reporter: ["text", "html"],
    },
  },
});
