import { DataSource } from 'typeorm';

import { AgentUsage } from '../otel/agent-usage.entity.js';

import { AgentRun } from './agent-run.entity.js';
import { AgentRunRecorder } from './agent-run.recorder.js';
import { AgentToolCall } from './agent-tool-call.entity.js';

/** An in-memory SQLite database with the run log tables, for unit tests. */
export async function runLogDb() {
    const ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [AgentRun, AgentToolCall, AgentUsage], synchronize: true }).initialize();
    const runs = ds.getRepository(AgentRun);
    const toolCalls = ds.getRepository(AgentToolCall);
    return { ds, runs, toolCalls, usage: ds.getRepository(AgentUsage), recorder: new AgentRunRecorder(runs, toolCalls) };
}
