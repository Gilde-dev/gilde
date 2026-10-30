import type { ReviewLimits } from './review-result.js';

export type StopReason = 'too_large' | 'timeout' | 'step_limit' | 'token_limit' | 'cancelled';

export interface StepUsage {
    inputTokens?: number | null;
    outputTokens?: number | null;
}

/**
 * Enforces the aggregate bounds of one review across all of its model steps. Every step re-sends the instructions, the data
 * and the earlier tool results, so the input of step n is counted in full, not only what is new. Usage reported by the
 * provider is used when it is higher than our own estimate, never when lower, so a provider that under-reports cannot let a
 * review run past its limit. Pure and clock-free: the executor owns the timer.
 */
export class ReviewMeter {
    inputUsed = 0;
    outputUsed = 0;
    /** Requests started so far (the one in flight counts). */
    steps = 0;
    private inflight = 0;
    private lastInput: number;
    private lastOutput = 0;
    /** Tokens of tool results added since the last request. */
    private pending = 0;
    stop: StopReason | null = null;
    stopDetail: string | null = null;

    /** `firstRequestTokens`: instructions plus the complete first prompt, as sized by the input assembler. */
    constructor(private readonly limits: ReviewLimits, firstRequestTokens: number) {
        this.lastInput = firstRequestTokens;
    }

    halt(reason: StopReason, detail: string): void {
        if (!this.stop) {
            this.stop = reason;
            this.stopDetail = detail;
        }
    }

    /** Estimated input of the request about to be sent. */
    nextRequestEstimate(): number {
        return this.steps === 0 ? this.lastInput : this.lastInput + this.lastOutput + this.pending;
    }

    /** Called before each model request. Returns the reason the request must not be sent, if any (and halts). */
    beforeStep(): StopReason | null {
        if (this.stop) return this.stop;
        const estimate = this.nextRequestEstimate();
        if (this.steps >= this.limits.maxSteps) this.halt('step_limit', `The review used its ${this.limits.maxSteps} allowed model steps without answering`);
        else if (this.inputUsed + estimate > this.limits.maxInputTokens) {
            this.halt(this.pending > 0 && this.inputUsed + estimate - this.pending <= this.limits.maxInputTokens ? 'too_large' : 'token_limit', `The next request needs about ${estimate} more input tokens; ${this.limits.maxInputTokens - this.inputUsed} of ${this.limits.maxInputTokens} are left`);
        } else if (this.outputUsed >= this.limits.maxOutputTokens) this.halt('token_limit', `The review used its ${this.limits.maxOutputTokens} output tokens`);
        else {
            // Reserve the request's input now, so a tool running inside this step sees the budget this step already took.
            this.steps++;
            this.inflight = estimate;
            this.inputUsed += estimate;
            this.lastInput = estimate;
            this.lastOutput = 0;
            this.pending = 0;
        }
        return this.stop;
    }

    /** Output tokens the next request may still produce. */
    remainingOutput(): number {
        return Math.max(1, this.limits.maxOutputTokens - this.outputUsed);
    }

    /** Whether a tool result of `tokens` still fits: the request that would carry it must fit in what is left. */
    toolResultFits(tokens: number): boolean {
        return this.inputUsed + this.lastInput + this.lastOutput + this.pending + tokens <= this.limits.maxInputTokens;
    }

    /** Why a tool result that does not fit stops the review: too_large when the request would have fit without it. */
    overflowReason(): StopReason {
        return this.inputUsed + this.lastInput + this.lastOutput + this.pending <= this.limits.maxInputTokens ? 'too_large' : 'token_limit';
    }

    addToolResult(tokens: number): void {
        this.pending += tokens;
    }

    /** Settles the step in flight with the provider's usage; the reserved estimate stays when it is higher than reported. */
    afterStep(usage: StepUsage | null | undefined): void {
        const input = Math.max(usage?.inputTokens ?? 0, this.inflight);
        const output = Math.max(usage?.outputTokens ?? 0, 0);
        this.inputUsed += input - this.inflight;
        this.inflight = 0;
        this.outputUsed += output;
        this.lastInput = input;
        this.lastOutput = output;
        if (this.inputUsed > this.limits.maxInputTokens) this.halt('token_limit', `The review used ${this.inputUsed} input tokens across its steps; the limit is ${this.limits.maxInputTokens}`);
        else if (this.outputUsed > this.limits.maxOutputTokens) this.halt('token_limit', `The review used ${this.outputUsed} output tokens; the limit is ${this.limits.maxOutputTokens}`);
    }
}
