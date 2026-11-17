import { describe, expect, test } from "vitest";

import {
	classifyContext,
	isRelayAddress,
	normalizeAddress,
} from "./address-class.ts";

describe("isRelayAddress", () => {
	test("flags the no-reply family and digest senders", () => {
		expect(isRelayAddress("noreply@somecorp.example")).toBe(true);
		expect(isRelayAddress("no-reply@somecorp.example")).toBe(true);
		expect(isRelayAddress("do-not-reply@somecorp.example")).toBe(true);
		expect(isRelayAddress("mailer-daemon@somecorp.example")).toBe(true);
		expect(
			isRelayAddress("example-messaging-digest-noreply@linkedin.com")
		).toBe(true);
		expect(isRelayAddress("notifications@forge.example")).toBe(true);
		expect(isRelayAddress("bounces+12345@sendgrid.example.org")).toBe(true);
	});

	test("flags known relay domains including subdomains", () => {
		expect(isRelayAddress("example-jobs@linkedin.com")).toBe(true);
		expect(isRelayAddress("example-anything@bounce.linkedin.com")).toBe(true);
		expect(isRelayAddress("example-updates@facebookmail.com")).toBe(true);
	});

	test("does not swallow humans whose names embed a keyword", () => {
		expect(isRelayAddress("annareply@example.com")).toBe(false);
		expect(isRelayAddress("robin@northwind.example")).toBe(false);
		expect(isRelayAddress("digestive.health@clinic.example")).toBe(false);
	});
});

describe("classifyContext", () => {
	test("freemail and langmail domains are private, organization domains are work", () => {
		expect(classifyContext("example-robin@gmail.com")).toBe("private");
		expect(classifyContext("example-user@langmail.me")).toBe("private");
		expect(classifyContext("robin@northwind.example")).toBe("work");
	});
});

describe("normalizeAddress", () => {
	test("lowercases and trims", () => {
		expect(normalizeAddress("  Robin@NorthWind.example ")).toBe(
			"robin@northwind.example"
		);
	});
});
