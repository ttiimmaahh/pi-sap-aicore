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
	},
];
