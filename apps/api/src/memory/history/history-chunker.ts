import { createHash } from 'node:crypto';

import type { HistoryDocument, HistorySourceType } from './history.types.js';

export const MAX_CHUNK_CHARS = 1200;
export const MAX_CHUNKS_PER_SOURCE = 8;

const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Splits a body into at most MAX_CHUNKS_PER_SOURCE chunks of at most MAX_CHUNK_CHARS, each starting with the header so a
 * chunk is understandable on its own. Deterministic: the same input always yields the same chunks.
 */
export function chunkText(header: string, body: string): string[] {
    const prefix = `${header.trim().slice(0, 300)}\n`;
    const room = MAX_CHUNK_CHARS - prefix.length;
    const lines = normalize(body).split('\n').flatMap((line) => {
        const pieces: string[] = [];
        for (let i = 0; i < line.length; i += room) pieces.push(line.slice(i, i + room));
        return pieces.length ? pieces : [''];
    });
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
        if (current && current.length + 1 + line.length > room) {
            chunks.push(current);
            current = line;
        } else {
            current = current ? `${current}\n${line}` : line;
        }
    }
    if (current.trim()) chunks.push(current);
    if (chunks.length > MAX_CHUNKS_PER_SOURCE) {
        chunks.length = MAX_CHUNKS_PER_SOURCE;
        chunks[MAX_CHUNKS_PER_SOURCE - 1] = `${chunks[MAX_CHUNKS_PER_SOURCE - 1].slice(0, room - 14)}\n[truncated]`;
    }
    return chunks.map((chunk) => `${prefix}${chunk}`);
}

/** Builds a document, or null when there is nothing to index. The hash covers the chunks and the scope. */
export function buildDocument(type: HistorySourceType, sourceId: string, projectId: string, repoId: string, header: string, body: string): HistoryDocument | null {
    const chunks = chunkText(header, body);
    if (chunks.length === 0) return null;
    const hash = createHash('sha256').update(JSON.stringify([type, sourceId, projectId, repoId, chunks])).digest('hex');
    return { type, sourceId, projectId, repoId, chunks, hash };
}
