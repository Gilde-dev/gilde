import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ExecutionError } from './execution.error.js';

export interface AgentInstructions {
    text: string | null;
    version: string | null;
}

interface Cached {
    path: string;
    mtimeMs: number;
    size: number;
    value: AgentInstructions;
}

/**
 * Reads the agent instructions file named by AGENT_INSTRUCTIONS_PATH (environment only, read-only).
 * The file is re-read when its mtime changes, so edits apply without a restart.
 */
@Injectable()
export class AgentInstructionsService implements OnModuleInit {
    private readonly logger = new Logger(AgentInstructionsService.name);
    private cached: Cached | null = null;

    onModuleInit(): void {
        if (!process.env.AGENT_INSTRUCTIONS_PATH) {
            this.logger.warn('AGENT_INSTRUCTIONS_PATH is not set: jobs are sent without agent instructions');
        }
    }

    /** Throws a config ExecutionError when the variable is set but the file is missing or empty. */
    get(): AgentInstructions {
        const configured = process.env.AGENT_INSTRUCTIONS_PATH;
        if (!configured) return { text: null, version: null };

        const path = resolve(configured);
        let stat;
        try {
            stat = statSync(path);
            if (!stat.isFile()) throw new Error('not a file');
        } catch {
            throw new ExecutionError(`Agent instructions file ${path} (AGENT_INSTRUCTIONS_PATH) is missing or unreadable`, 'config');
        }
        if (this.cached && this.cached.path === path && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size) {
            return this.cached.value;
        }

        let text: string;
        try {
            text = readFileSync(path, 'utf8');
        } catch {
            throw new ExecutionError(`Agent instructions file ${path} (AGENT_INSTRUCTIONS_PATH) is missing or unreadable`, 'config');
        }
        if (!text.trim()) {
            throw new ExecutionError(`Agent instructions file ${path} (AGENT_INSTRUCTIONS_PATH) is empty`, 'config');
        }
        const value = { text, version: createHash('sha256').update(text).digest('hex').slice(0, 12) };
        this.cached = { path, mtimeMs: stat.mtimeMs, size: stat.size, value };
        return value;
    }
}
