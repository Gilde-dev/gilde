export const TEXT_JACCARD_THRESHOLD = 0.6;

/** Lowercased, code spans and punctuation stripped, as a set of tokens. */
export function textTokens(text: string): Set<string> {
    const cleaned = text.toLowerCase().replace(/`[^`]*`/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ');
    return new Set(cleaned.split(/\s+/).filter(Boolean));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    return shared / (a.size + b.size - shared);
}

export function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Single-link clustering: items are in one group when a chain of pairs with similarity >= threshold connects them.
 * Items are visited in the order given (callers sort by id), groups are returned in order of their first item and
 * members in input order, so the same input always gives the same groups.
 */
export function singleLinkGroups(count: number, similarity: (i: number, j: number) => number, threshold: number): number[][] {
    const parent = Array.from({ length: count }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
            if (similarity(i, j) >= threshold) parent[Math.max(find(i), find(j))] = Math.min(find(i), find(j));
        }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < count; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
    return [...groups.values()];
}
