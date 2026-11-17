import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			exclude: ["node_modules/", "dist/", "e2e/", "**/*.config.{js,ts}"],
			provider: "v8",
			reporter: ["text", "json", "html"],
		},
		// Whole-day dates only shift east of UTC; CI runs in UTC and would never
		// see those bugs.
		env: { TZ: "Europe/Berlin" },
		environment: "node",
		globals: true,
		include: ["src/**/*.test.ts"],
	},
});
