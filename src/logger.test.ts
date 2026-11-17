import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_LOG_LEVEL, hashEmail, resolveLevel } from "./logger.ts";

const TWELVE_HEX_CHARS = /^[0-9a-f]{12}$/u;
const LOGGER_PATH = fileURLToPath(new URL("./logger.ts", import.meta.url));

describe("resolveLevel", () => {
	test("defaults to warn when unset or blank", () => {
		expect(DEFAULT_LOG_LEVEL).toBe("warn");
		expect(resolveLevel(undefined)).toBe("warn");
		expect(resolveLevel("")).toBe("warn");
		expect(resolveLevel("  ")).toBe("warn");
	});

	test("accepts every pino level, in any case", () => {
		for (const level of ["fatal", "error", "warn", "info", "debug", "trace"]) {
			expect(resolveLevel(level)).toBe(level);
		}
		expect(resolveLevel("INFO")).toBe("info");
		expect(resolveLevel(" Debug ")).toBe("debug");
		expect(resolveLevel("silent")).toBe("silent");
	});

	test("falls back to the default for an unknown level and says so on stderr", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			expect(resolveLevel("loud")).toBe("warn");
			expect(write).toHaveBeenCalledTimes(1);
			expect(String(write.mock.calls[0]?.[0])).toContain('LOG_LEVEL "loud"');
		} finally {
			write.mockRestore();
		}
	});
});

describe("logger", () => {
	// A child process, because the destination is the real file descriptor.
	const run = (level: string | undefined) =>
		spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				`const { logger } = await import(${JSON.stringify(LOGGER_PATH)});
				logger.info({ tool: "get_email" }, "an info line");
				logger.warn({ tool: "get_email" }, "a warn line");
				logger.error({ status: 502 }, "an error line");`,
			],
			{
				encoding: "utf8",
				env: { ...process.env, LOG_LEVEL: level, NODE_NO_WARNINGS: "1" },
			}
		);

	test("writes JSON lines to stderr and nothing to stdout", () => {
		const result = run("info");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		const lines = result.stderr
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.map((line) => line.msg)).toEqual([
			"an info line",
			"a warn line",
			"an error line",
		]);
		expect(lines[0]).toMatchObject({ level: 30, tool: "get_email" });
		// No machine details ride along.
		expect(lines[0]).not.toHaveProperty("hostname");
		expect(lines[0]).not.toHaveProperty("pid");
	});

	test("stays quiet below warn by default", () => {
		const result = run(undefined);
		expect(result.stdout).toBe("");
		expect(
			result.stderr
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { msg: string }).msg)
		).toEqual(["a warn line", "an error line"]);
	});
});

describe("hashEmail", () => {
	test("is the first 12 hex chars of SHA-256 over the lowercased input", () => {
		const hash = hashEmail("Nerissa@Example.com");
		expect(hash).toMatch(TWELVE_HEX_CHARS);
		expect(hash).toBe(
			createHash("sha256")
				.update("nerissa@example.com")
				.digest("hex")
				.slice(0, 12)
		);
		// Pinned: changing the algorithm breaks correlation between log lines.
		expect(hashEmail("nerissa@example.com")).toBe("c08bf56c1403");
	});

	test("does not carry the plaintext", () => {
		expect(hashEmail("nerissa@example.com")).not.toContain("nerissa");
	});
});
