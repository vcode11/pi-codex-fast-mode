import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexFastMode, {
	FAST_MODE_MODEL_IDS,
	addPriorityServiceTier,
	parseFastCommand,
	routingHint,
	setRoutingHint,
	settingsPath,
	supportsFastMode,
} from "../extensions/codex-fast-mode.ts";

const supportedModel = {
	provider: "openai-codex",
	id: "gpt-5.6-sol",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};

const astraModel = {
	provider: "openai",
	id: "gpt-6-astra",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
};

test("fast mode model allowlist matches the current Codex catalog", () => {
	assert.deepEqual([...FAST_MODE_MODEL_IDS], [
		"gpt-5.4",
		"gpt-5.5",
		"gpt-5.6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-6-astra",
	]);
	assert.equal(supportsFastMode(supportedModel), true);
	assert.equal(supportsFastMode({ ...supportedModel, id: "gpt-6-astra" }), true);
	assert.equal(supportsFastMode({ ...supportedModel, id: "gpt-5.4-mini" }), false);
	assert.equal(supportsFastMode({ ...supportedModel, id: "gpt-5.3-codex-spark" }), false);
	assert.equal(supportsFastMode({ ...supportedModel, provider: "openai" }), false);
	assert.equal(supportsFastMode({ ...supportedModel, api: "anthropic-messages" }), false);
	assert.equal(supportsFastMode({ ...supportedModel, baseUrl: "https://example.com" }), false);
	assert.equal(supportsFastMode(undefined), false);
});

test("API-key Astra fast mode is restricted to the official OpenAI Responses endpoint", () => {
	assert.equal(supportsFastMode(astraModel), true);
	for (const override of [
		{ provider: "openai-codex" },
		{ provider: "custom" },
		{ api: "openai-completions" },
		{ api: undefined },
		{ baseUrl: "https://example.com/v1" },
		{ baseUrl: "https://api.openai.com.evil.example/v1" },
		{ baseUrl: undefined },
		{ id: "gpt-6-unknown" },
		{ id: "gpt-5.4-mini" },
	]) {
		assert.equal(supportsFastMode({ ...astraModel, ...override }), false);
	}
});

test("priority request fields preserve the provider payload", () => {
	const payload = { model: "gpt-5.6-sol", stream: true, service_tier: "default" };
	assert.deepEqual(addPriorityServiceTier(payload), {
		model: "gpt-5.6-sol",
		stream: true,
		service_tier: "priority",
	});
	assert.deepEqual(payload, { model: "gpt-5.6-sol", stream: true, service_tier: "default" });
	assert.equal(addPriorityServiceTier("body"), "body");
	assert.equal(routingHint(supportedModel), "model=gpt-5.6-sol;tier=priority");
	const headers = { "X-Codex-Routing-Hint": "stale", Accept: "application/json" };
	setRoutingHint(headers, supportedModel);
	assert.deepEqual(headers, {
		Accept: "application/json",
		"x-codex-routing-hint": "model=gpt-5.6-sol;tier=priority",
	});
});

test("fast command parser supports native-style actions and toggle", () => {
	assert.equal(parseFastCommand(""), "toggle");
	assert.equal(parseFastCommand(" ON "), "on");
	assert.equal(parseFastCommand("off"), "off");
	assert.equal(parseFastCommand("status"), "status");
	assert.equal(parseFastCommand("turbo"), undefined);
});

test("settings path follows Pi tilde expansion", () => {
	const previousConfigDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "~/.config/pi-fast-test";
	try {
		assert.equal(settingsPath(), join(homedir(), ".config", "pi-fast-test", "codex-fast-mode.json"));
	} finally {
		if (previousConfigDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDirectory;
	}
});

test("extension persists Fast mode and switches between Codex and OpenAI request signals", async () => {
	const configDirectory = await mkdtemp(join(tmpdir(), "pi-codex-fast-mode-"));
	const previousConfigDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = configDirectory;

	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const context = {
		model: supportedModel,
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	type TestContext = typeof context;
	type TestHandler = (event: Record<string, unknown>, ctx: TestContext) => unknown;
	type TestCommand = { handler: (args: string, ctx: TestContext) => Promise<void> };
	const handlers = new Map<string, TestHandler>();
	let command: TestCommand | undefined;
	const pi = {
		registerFlag: () => undefined,
		getFlag: () => false,
		registerCommand: (_name: string, options: unknown) => {
			command = options as TestCommand;
		},
		on: (event: string, handler: unknown) => {
			handlers.set(event, handler as TestHandler);
		},
	};

	try {
		codexFastMode(pi as never);
		await handlers.get("session_start")?.({}, context);
		assert.equal(
			await handlers
				.get("before_provider_request")
				?.({ payload: { model: "gpt-5.6-sol" } }, context),
			undefined,
		);

		assert.ok(command);
		await command.handler("on", context);
		assert.deepEqual(JSON.parse(await readFile(join(configDirectory, "codex-fast-mode.json"), "utf8")), {
			version: 1,
			enabled: true,
		});
		await handlers.get("session_start")?.({}, context);

		const payload = await handlers
			.get("before_provider_request")
			?.({ payload: { model: "gpt-5.6-sol", stream: true } }, context);
		assert.deepEqual(payload, { model: "gpt-5.6-sol", stream: true, service_tier: "priority" });

		const headers: Record<string, string> = { "X-Codex-Routing-Hint": "stale" };
		await handlers.get("before_provider_headers")?.({ headers }, context);
		assert.deepEqual(headers, {
			"x-codex-routing-hint": "model=gpt-5.6-sol;tier=priority",
		});
		const customContext = {
			...context,
			model: { ...supportedModel, baseUrl: "https://example.com" },
		};
		assert.equal(
			await handlers
				.get("before_provider_request")
				?.({ payload: { model: "gpt-5.6-sol" } }, customContext),
			undefined,
		);
		const customHeaders: Record<string, string> = {};
		await handlers.get("before_provider_headers")?.({ headers: customHeaders }, customContext);
		assert.deepEqual(customHeaders, {});
		assert.equal(statuses.at(-1), "⚡ fast");

		context.model = astraModel;
		await handlers.get("model_select")?.({ model: astraModel }, context);
		assert.equal(statuses.at(-1), "⚡ fast");
		await command.handler("status", context);
		assert.deepEqual(notifications.at(-1), {
			message: "Fast mode is on for openai/gpt-6-astra",
			type: "info",
		});
		const astraPayload = { model: astraModel.id, stream: true, service_tier: "default" };
		assert.deepEqual(
			await handlers.get("before_provider_request")?.({ payload: astraPayload }, context),
			{ ...astraPayload, service_tier: "priority" },
		);
		assert.equal(astraPayload.service_tier, "default");
		const astraHeaders = { Accept: "application/json" };
		await handlers.get("before_provider_headers")?.({ headers: astraHeaders }, context);
		assert.deepEqual(astraHeaders, { Accept: "application/json" });
		for (const payload of [null, "body", [], {}, { model: supportedModel.id }]) {
			assert.equal(await handlers.get("before_provider_request")?.({ payload }, context), undefined);
		}
		const customAstraContext = {
			...context,
			model: { ...astraModel, baseUrl: "https://example.com/v1" },
		};
		assert.equal(
			await handlers.get("before_provider_request")?.({ payload: astraPayload }, customAstraContext),
			undefined,
		);
		await handlers.get("model_select")?.({ model: customAstraContext.model }, customAstraContext);
		assert.equal(statuses.at(-1), "⚡ fast unavailable");
		await handlers.get("session_start")?.({}, context);
		assert.equal(statuses.at(-1), "⚡ fast");

		await command.handler("off", context);
		for (const model of [supportedModel, astraModel]) {
			const disabledContext = { ...context, model };
			assert.equal(
				await handlers.get("before_provider_request")?.({ payload: { model: model.id } }, disabledContext),
				undefined,
			);
			const disabledHeaders = {};
			await handlers.get("before_provider_headers")?.({ headers: disabledHeaders }, disabledContext);
			assert.deepEqual(disabledHeaders, {});
		}
		assert.equal(statuses.at(-1), undefined);
		assert.deepEqual(JSON.parse(await readFile(join(configDirectory, "codex-fast-mode.json"), "utf8")), {
			version: 1,
			enabled: false,
		});
		assert.equal(notifications.at(-1)?.message, "Fast mode is off");
	} finally {
		if (previousConfigDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDirectory;
		await rm(configDirectory, { recursive: true, force: true });
	}
});
