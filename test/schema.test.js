/**
 * Schema-compatibility tests.
 *
 * These guard the two seams that fail silently outside a booted harness and
 * that the sibling `dsh-plugin-git-workflow` fails outright:
 *
 * 1. `ctx.tools.register()` stores a definition verbatim and compiles nothing.
 *    A parameter spec that never went through `defineTool` reaches the model
 *    provider as a bare property map — no top-level `type` — and the provider
 *    rejects the entire turn, naming only the alphabetically first tool.
 * 2. Schema keywords that one harness version accepts and another rejects
 *    (`required`, `enum`, `default`) turn a working plugin into a load-time
 *    crash when the harness is upgraded. The plugin therefore avoids them and
 *    enforces the same constraints in code.
 *
 * @module dsh-tool-git/test/schema
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { Config, defineTools, inject, name } from "../index.js";

/** Defaults matching the plugin's own Config defaults. */
const SETTINGS = { timeoutMs: 30_000, maxDiffLines: 500, maxLogEntries: 50, requireApprovalForWrites: true };

const definitions = defineTools({ get: () => undefined }, SETTINGS);

test("the plugin exports the shape Cordis loads", () => {
	assert.equal(typeof name, "string");
	assert.equal(name, "dsh-tool-git");
	assert.deepEqual(inject, ["tools"]);
	// Config is a schemastery schema object, which is a callable factory.
	assert.equal(typeof Config, "function");
});

test("every definition survives defineTool", () => {
	assert.equal(definitions.length, 6);
	for (const definition of definitions) {
		const tool = defineTool(definition);
		assert.equal(tool.name, definition.name);
	}
});

test("defineTool compiles parameters into a top-level object schema", () => {
	// Without this compilation the provider sees the authoring DSL and fails
	// the whole request. Asserting the compiled shape is the only way to catch
	// a regression here without a live provider round-trip.
	for (const definition of definitions) {
		const tool = defineTool(definition);
		assert.equal(tool.parameters.type, "object", `${definition.name} parameters must compile to an object schema`);
		assert.equal(typeof tool.parameters.properties, "object", `${definition.name} must expose properties`);
		assert.equal("required" in tool.parameters.properties, false);
	}
});

test("parameters avoid schema keywords whose support differs by harness version", () => {
	for (const definition of definitions) {
		for (const [key, spec] of Object.entries(definition.parameters)) {
			// 0.1.6-alpha.2 rejects `required` on a non-object property with
			// UNSUPPORTED_SCHEMA; 0.1.5-rc.2 accepted it. The lowest common
			// denominator is to omit it and validate in code.
			assert.equal("required" in spec, false, `${definition.name}.${key} must not declare required`);
			// A provider rejects the whole function schema once it contains
			// `enum`, reporting only `got 'type: null'`.
			assert.equal("enum" in spec, false, `${definition.name}.${key} must not declare enum`);
			assert.equal("default" in spec, false, `${definition.name}.${key} must not declare default`);
			assert.ok(["string", "boolean", "integer", "array"].includes(spec.type), `${definition.name}.${key} has an unexpected type`);
		}
	}
});

test("output schemas declare additionalProperties explicitly at every level", () => {
	// The value-schema DSL rejects an object node without an explicit
	// additionalProperties, so a missing one is a register-time failure.
	const walk = (node, path) => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
			return;
		}
		if (node.type === "object") {
			assert.ok("additionalProperties" in node, `${path} must declare additionalProperties explicitly`);
		}
		for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
	};
	for (const definition of definitions) walk(definition.output.schema, definition.name);
});

test("output schemas never use a union type", () => {
	// `type: ["integer", "null"]` is rejected by the value-schema DSL; a field
	// that may be absent is simply omitted from the returned value.
	const walk = (node, path) => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) return node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
		if ("type" in node) assert.equal(Array.isArray(node.type), false, `${path} must not use a union type`);
		for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
	};
	for (const definition of definitions) walk(definition.output.schema, definition.name);
});

test("every tool declares a render function and a bounded timeout", () => {
	for (const definition of definitions) {
		assert.equal(typeof definition.output.render, "function", `${definition.name} needs output.render`);
		assert.ok(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0, `${definition.name} needs a positive timeoutMs`);
		assert.equal(typeof definition.execute, "function", `${definition.name} needs execute`);
		assert.equal(typeof definition.description, "string");
		// A description that does not say when to prefer the tool over bash
		// wastes the guidance budget the model reads.
		assert.ok(definition.description.length > 80, `${definition.name} description is too thin to guide the model`);
	}
});
