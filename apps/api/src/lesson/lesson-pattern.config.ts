export const DEFAULT_LESSON_PATTERN_SIMILARITY = 0.85;

/** Cosine similarity above which two lessons are one pattern when embeddings are on. A set but invalid value throws: grouping fails closed rather than silently using the default. */
export function lessonPatternSimilarity(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.LESSON_PATTERN_SIMILARITY?.trim();
    if (!raw) return DEFAULT_LESSON_PATTERN_SIMILARITY;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`LESSON_PATTERN_SIMILARITY must be a number above 0 and at most 1, got "${raw}"`);
    return n;
}
