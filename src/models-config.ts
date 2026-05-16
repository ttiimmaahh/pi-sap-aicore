type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SapModel = {
	id: string;
	name: string;
	reasoning: boolean;
	tool_call: boolean;
	temperature: boolean;
	modalities: {
		input: ("text" | "image" | "pdf")[];
		output: ("text")[];
	};
	limit: {
		context: number;
		output: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

// Anthropic extended-thinking budget_tokens per pi level.
// minimum allowed by Anthropic API is 1024; xhigh stays well under typical
// max_output_tokens so the response itself still has room to render.
const ANTHROPIC_THINKING: SapModel["thinkingLevelMap"] = {
	minimal: "1024",
	low: "4096",
	medium: "8192",
	high: "16384",
	xhigh: "32768",
};

// OpenAI reasoning_effort accepts minimal/low/medium/high — no xhigh tier.
// Omitting xhigh causes pi to skip that level when cycling on these models.
const OPENAI_THINKING: SapModel["thinkingLevelMap"] = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

export const MODELS: SapModel[] = [
	{
		id: "anthropic--claude-4.7-opus",
		name: "Claude Opus 4.7",
		reasoning: true,
		tool_call: true,
		temperature: true,
		modalities: {
			input: ["text", "image", "pdf"],
			output: ["text"],
		},
		limit: {
			context: 200_000,
			output: 32_000,
		},
		cost: {
			input: 15,
			output: 75,
			cacheRead: 1.5,
			cacheWrite: 18.75,
		},
		thinkingLevelMap: ANTHROPIC_THINKING,
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		tool_call: true,
		temperature: false,
		modalities: {
			input: ["text", "image", "pdf"],
			output: ["text"],
		},
		limit: {
			context: 400_000,
			output: 128_000,
		},
		cost: {
			input: 2.5,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
		},
		thinkingLevelMap: OPENAI_THINKING,
	},
];
