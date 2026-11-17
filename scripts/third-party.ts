// Which third-party packages end up inside the bundled email viewer, and the
// notices that have to travel with it.
//
// The viewer (dist/email-render/email-viewer.html) is one file with other
// people's code compiled into it. Their licenses (MIT, Apache-2.0) ask that
// the copyright and license notices accompany every copy, so the list is
// derived from what the bundler actually put in the file, not kept by hand:
// - the packages esbuild's metafile says contributed bytes to the output;
// - the packages those packages had already compiled into their own files,
//   which the metafile cannot see. Their bundler left a `#region` marker with
//   the package's path in front of each such module.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
// License texts of packages that are compiled into another package's files
// and so are not in node_modules under their own name and version. One file
// per package, named `<name with / as +>@<version>.LICENSE`.
const VENDORED_LICENSE_DIR = join(REPOSITORY_ROOT, "scripts", "third-party");

const NODE_MODULES = "node_modules/";
// `#region ../../node_modules/.pnpm/content-type@1.0.5/node_modules/content-type/index.js`
const VENDORED_REGION_RE =
	/#region \S*?node_modules\/\.pnpm\/[^/\s]*?@(\d[^/_\s]*)[^/\s]*\/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gu;
// A copyright statement ("Copyright (c) 2015 …"), not a sentence of a license
// that happens to start with the word.
const COPYRIGHT_LINE_RE = /^\s*Copyright\s*(?:\(c\)|©|\d{4}).*$/mu;
const LICENSE_FILE_RE = /^(licen[sc]e|copying)(\.|$)/iu;
const NOTICE_FILE_RE = /^notice(\.|$)/iu;
const GIT_PREFIX_RE = /^git\+/u;
const GIT_SUFFIX_RE = /\.git$/u;

export interface BundledPackage {
	// The first copyright line of the license text, when it has one.
	copyright?: string;
	// The SPDX id the package declares in its package.json.
	license: string;
	licenseText: string;
	name: string;
	// The content of the package's NOTICE file, when it ships one.
	notice?: string;
	repository?: string;
	// The package whose published files this one is compiled into.
	vendoredIn?: string;
	version: string;
}

interface Manifest {
	license?: string;
	name: string;
	repository?: string | { url?: string };
	version: string;
}

const copyrightOf = (text: string): string | undefined =>
	COPYRIGHT_LINE_RE.exec(text)?.[0].trim();

const repositoryOf = (manifest: Manifest): string | undefined => {
	const url =
		typeof manifest.repository === "string"
			? manifest.repository
			: manifest.repository?.url;
	return url?.replace(GIT_PREFIX_RE, "").replace(GIT_SUFFIX_RE, "");
};

// The directory of the package a bundled file belongs to: everything up to
// and including the package name after the last `node_modules/`.
const packageDirOf = (input: string): string | undefined => {
	const at = input.lastIndexOf(NODE_MODULES);
	if (at === -1) {
		return undefined;
	}
	const rest = input.slice(at + NODE_MODULES.length).split("/");
	const name = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
	return join(input.slice(0, at + NODE_MODULES.length), ...name);
};

const readFirst = (dir: string, pattern: RegExp): string | undefined => {
	const file = readdirSync(dir)
		.sort()
		.find((name) => pattern.test(name));
	return file ? readFileSync(join(dir, file), "utf8").trim() : undefined;
};

const installedPackage = (dir: string): BundledPackage => {
	const manifest = JSON.parse(
		readFileSync(join(dir, "package.json"), "utf8")
	) as Manifest;
	const licenseText = readFirst(dir, LICENSE_FILE_RE);
	if (!(manifest.license && licenseText)) {
		throw new Error(
			`${manifest.name}@${manifest.version} is bundled into the email viewer but declares no license or ships no license file. Decide whether it may ship, and say where its notice comes from in scripts/third-party.ts.`
		);
	}
	const notice = readFirst(dir, NOTICE_FILE_RE);
	const copyright = copyrightOf(licenseText);
	const repository = repositoryOf(manifest);
	return {
		...(copyright ? { copyright } : {}),
		license: manifest.license,
		licenseText,
		name: manifest.name,
		...(notice ? { notice } : {}),
		...(repository ? { repository } : {}),
		version: manifest.version,
	};
};

// What the vendored packages declare in their own package.json. Their
// published tarballs are not installed here, so this is written down; the
// license text itself is a file in scripts/third-party/.
const VENDORED: Record<string, { license: string; repository: string }> = {
	"@cfworker/json-schema@4.1.1": {
		license: "MIT",
		repository: "https://github.com/cfworker/cfworker",
	},
	"content-type@1.0.5": {
		license: "MIT",
		repository: "https://github.com/jshttp/content-type",
	},
};

const vendoredPackage = (
	name: string,
	version: string,
	vendoredIn: string
): BundledPackage => {
	const key = `${name}@${version}`;
	const file = join(
		VENDORED_LICENSE_DIR,
		`${key.replaceAll("/", "+")}.LICENSE`
	);
	const declared = VENDORED[key];
	if (!(declared && existsSync(file))) {
		throw new Error(
			`${vendoredIn} has ${key} compiled into the files the email viewer bundles, and its notice is not on record. Add its license text as scripts/third-party/${key.replaceAll("/", "+")}.LICENSE (from the package's repository at that version), add its license id and repository to VENDORED in scripts/third-party.ts, and run \`npm run notices\`.`
		);
	}
	const licenseText = readFileSync(file, "utf8").trim();
	const copyright = copyrightOf(licenseText);
	return {
		...(copyright ? { copyright } : {}),
		...declared,
		licenseText,
		name,
		vendoredIn,
		version,
	};
};

/**
 * The third-party packages behind the given bundled files (paths as esbuild's
 * metafile names them, relative to the repository root), sorted by name.
 */
export const bundledPackages = (inputs: string[]): BundledPackage[] => {
	const found = new Map<string, BundledPackage>();
	for (const input of inputs) {
		const dir = packageDirOf(input);
		if (!dir) {
			continue;
		}
		const pkg = installedPackage(join(REPOSITORY_ROOT, dir));
		found.set(`${pkg.name}@${pkg.version}`, pkg);
		const source = readFileSync(join(REPOSITORY_ROOT, input), "utf8");
		for (const [, version, name] of source.matchAll(VENDORED_REGION_RE)) {
			if (name && version) {
				found.set(
					`${name}@${version}`,
					vendoredPackage(name, version, `${pkg.name}@${pkg.version}`)
				);
			}
		}
	}
	return [...found.values()].sort((a, b) =>
		`${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1
	);
};

/**
 * A comment for the top of the bundled script: who wrote what is in it and
 * under which license, and where the full texts are. It goes out with every
 * copy of the viewer a host reads.
 */
export const noticeBanner = (packages: BundledPackage[]): string => {
	const lines = packages.map((pkg) =>
		// A license line must not be able to close the comment.
		` * ${pkg.name} ${pkg.version} (${pkg.license})${pkg.copyright ? ` ${pkg.copyright}` : ""}`.replaceAll(
			"*/",
			"* /"
		)
	);
	return [
		"/*!",
		" * This file bundles third-party software:",
		...lines,
		" * Full license texts: THIRD_PARTY_NOTICES.md in the langmail-mcp package",
		" * and at https://github.com/langmail/langmail-mcp.",
		" */",
	].join("\n");
};

const fenced = (text: string): string => `\`\`\`text\n${text}\n\`\`\``;

/** The content of THIRD_PARTY_NOTICES.md. */
export const renderNotices = (packages: BundledPackage[]): string => {
	const firstWithText = new Map<string, string>();
	const sections = packages.map((pkg) => {
		const title = `${pkg.name} ${pkg.version}`;
		const same = firstWithText.get(pkg.licenseText);
		if (!same) {
			firstWithText.set(pkg.licenseText, title);
		}
		return [
			`## ${title}`,
			"",
			`- License: ${pkg.license}`,
			...(pkg.copyright ? [`- ${pkg.copyright}`] : []),
			...(pkg.repository ? [`- Source: <${pkg.repository}>`] : []),
			...(pkg.vendoredIn
				? [
						`- Compiled into the published files of ${pkg.vendoredIn}, and bundled from there.`,
					]
				: []),
			`- NOTICE file: ${pkg.notice ? "included below." : "the package ships none."}`,
			"",
			same
				? `License text: identical to the one under "${same}" above.`
				: fenced(pkg.licenseText),
			...(pkg.notice ? ["", "NOTICE:", "", fenced(pkg.notice)] : []),
		].join("\n");
	});
	return `${[
		"# Third-party notices",
		"",
		"The published package contains `dist/email-render/email-viewer.html`, the view an MCP Apps host shows a previewed email in. That one file has the code of the packages below compiled into it, so their copyright and license notices are reproduced here.",
		"",
		"This file is generated from what the bundler put into the viewer (`npm run notices`, `scripts/third-party.ts`). Do not edit it by hand; `npm test` fails when it no longer matches the bundle.",
		"",
		"The packages this server depends on at run time are not in this list: npm installs them next to it, each with its own license file.",
		"",
		"| Package | Version | License |",
		"| --- | --- | --- |",
		...packages.map(
			(pkg) => `| ${pkg.name} | ${pkg.version} | ${pkg.license} |`
		),
		"",
		...sections.flatMap((section) => [section, ""]),
	]
		.join("\n")
		.trimEnd()}\n`;
};

/** Where the notices file lives: next to LICENSE, in the package. */
export const NOTICES_FILE = join(REPOSITORY_ROOT, "THIRD_PARTY_NOTICES.md");
