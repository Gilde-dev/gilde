import { z } from 'zod';

/** USD per million tokens. Prices only come from the LLM_PRICES env var; nothing is hard-coded. */
const PriceSchema = z.object({ input: z.number().min(0), cachedInput: z.number().min(0).optional(), output: z.number().min(0).optional() });
const PricesSchema = z.record(z.string(), PriceSchema);

export type ModelPrice = z.infer<typeof PriceSchema>;
export type ModelPrices = Record<string, ModelPrice>;

export interface TokenCounts {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
}

/** Parses LLM_PRICES (JSON: model id -> { input, cachedInput, output }). Invalid or missing means no prices. */
export function parsePrices(raw: string | undefined): ModelPrices {
    if (!raw?.trim()) return {};
    try {
        const parsed = PricesSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

/**
 * Cost in USD, or null when the model has no price. Cached input tokens are part of the input tokens and billed at
 * the cached price (the input price when none is given); output tokens already include reasoning tokens.
 */
export function computeCost(prices: ModelPrices, model: string, tokens: TokenCounts): number | null {
    const price = prices[model] ?? prices[model.slice(model.indexOf('/') + 1)];
    if (!price) return null;
    const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
    const cachedPrice = price.cachedInput ?? price.input;
    return ((tokens.inputTokens - cached) * price.input + cached * cachedPrice + tokens.outputTokens * (price.output ?? 0)) / 1_000_000;
}
