import { defineConfig } from "vitest/config";

// The end-to-end suites talk to a real Stalwart (see e2e/README.md). They share
// one server, so files run one after another.
export default defineConfig({
	test: {
		environment: "node",
		fileParallelism: false,
		globals: true,
		hookTimeout: 120_000,
		include: ["e2e/**/*.e2e.test.ts"],
		passWithNoTests: true,
		testTimeout: 60_000,
	},
});
