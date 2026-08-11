import { dirname, join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-fast-mode";
const SETTINGS_FILE = "codex-fast-mode.json";
const ROUTING_HEADER = "x-codex-routing-hint";
const CODEX_API = "openai-codex-responses";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export const FAST_MODE_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

type FastCommand = "on" | "off" | "status" | "toggle";
type ModelIdentity = {
	provider: string;
	id: string;
	api?: string;
	baseUrl?: string;
};

type MutableHeaders = Record<string, string | null>;

type StoredSettings = {
	version: 1;
	enabled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsFastMode(model: ModelIdentity | undefined): boolean {
	return (
		model?.provider === "openai-codex" &&
		model.api === CODEX_API &&
		model.baseUrl === CODEX_BASE_URL &&
		FAST_MODE_MODEL_IDS.has(model.id)
	);
}

export function addPriorityServiceTier(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	return { ...payload, service_tier: "priority" };
}

export function routingHint(model: ModelIdentity): string {
	return `model=${model.id};tier=priority`;
}

export function setRoutingHint(headers: MutableHeaders, model: ModelIdentity): void {
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === ROUTING_HEADER) delete headers[name];
	}
	headers[ROUTING_HEADER] = routingHint(model);
}

export function parseFastCommand(args: string): FastCommand | undefined {
	const action = args.trim().toLowerCase();
	if (action === "") return "toggle";
	if (action === "on" || action === "off" || action === "status") return action;
	return undefined;
}

export function settingsPath(): string {
	return join(getAgentDir(), SETTINGS_FILE);
}

function parseStoredSettings(value: unknown): StoredSettings {
	if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean") {
		throw new Error("expected { version: 1, enabled: boolean }");
	}
	return value as StoredSettings;
}

async function loadEnabled(): Promise<{ enabled: boolean; warning?: string }> {
	const path = settingsPath();
	try {
		const settings = parseStoredSettings(JSON.parse(await readFile(path, "utf8")));
		return { enabled: settings.enabled };
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { enabled: false };
		const message = error instanceof Error ? error.message : String(error);
		return { enabled: false, warning: `Could not read ${path}: ${message}` };
	}
}

async function saveEnabled(enabled: boolean): Promise<void> {
	const path = settingsPath();
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(
			temporaryPath,
			`${JSON.stringify({ version: 1, enabled } satisfies StoredSettings, null, 2)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await rename(temporaryPath, path);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

function stateDescription(enabled: boolean, model: ModelIdentity | undefined): string {
	if (!enabled) return "Fast mode is off";
	if (!model) return "Fast mode is on; no model is selected";
	if (!supportsFastMode(model)) return `Fast mode is on but unavailable for ${model.provider}/${model.id}`;
	return `Fast mode is on for ${model.provider}/${model.id}`;
}

function updateStatus(enabled: boolean, model: ModelIdentity | undefined, ctx: ExtensionContext): void {
	if (!enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const text = supportsFastMode(model) ? "⚡ fast" : "⚡ fast unavailable";
	const color = supportsFastMode(model) ? "accent" : "warning";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
}

export default function codexFastMode(pi: ExtensionAPI): void {
	let enabled = false;

	pi.registerFlag("fast", {
		description: "Enable OpenAI Codex Fast mode for this Pi process",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast mode or use on, off, status",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status"].filter((option) => option.startsWith(prefix.trim().toLowerCase()));
			return options.map((option) => ({ value: option, label: option }));
		},
		handler: async (args, ctx) => {
			const action = parseFastCommand(args);
			if (!action) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}
			if (action === "status") {
				ctx.ui.notify(stateDescription(enabled, ctx.model), "info");
				return;
			}

			enabled = action === "toggle" ? !enabled : action === "on";
			updateStatus(enabled, ctx.model, ctx);
			try {
				await saveEnabled(enabled);
				ctx.ui.notify(stateDescription(enabled, ctx.model), supportsFastMode(ctx.model) || !enabled ? "info" : "warning");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`${stateDescription(enabled, ctx.model)}, but the setting could not be saved: ${message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const stored = await loadEnabled();
		enabled = stored.enabled || pi.getFlag("fast") === true;
		updateStatus(enabled, ctx.model, ctx);
		if (stored.warning) ctx.ui.notify(stored.warning, "warning");
	});

	pi.on("model_select", (event, ctx) => {
		updateStatus(enabled, event.model, ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !ctx.model || !supportsFastMode(ctx.model)) return;
		if (!isRecord(event.payload) || event.payload.model !== ctx.model.id) return;
		return addPriorityServiceTier(event.payload);
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!enabled || !ctx.model || !supportsFastMode(ctx.model)) return;
		setRoutingHint(event.headers, ctx.model);
	});
}
