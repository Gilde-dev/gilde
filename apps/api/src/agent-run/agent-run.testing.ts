import { DataSource } from 'typeorm';

import { Executor } from '../executor/executor.entity.js';
import { JobRun } from '../run/run.entity.js';
import { User } from '../user/user.entity.js';
import { AgentUsage } from '../otel/agent-usage.entity.js';

import { AgentRun } from './agent-run.entity.js';
import { AgentRunRecorder } from './agent-run.recorder.js';
import { AgentToolCall } from './agent-tool-call.entity.js';

/** An in-memory SQLite database with the run log tables, for unit tests. */
export async function runLogDb() {
    const ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [AgentRun, AgentToolCall, AgentUsage, JobRun, Executor, User], synchronize: true }).initialize();
    const runs = ds.getRepository(AgentRun);
    const toolCalls = ds.getRepository(AgentToolCall);
    return { ds, runs, toolCalls, usage: ds.getRepository(AgentUsage), jobRuns: ds.getRepository(JobRun), executors: ds.getRepository(Executor), users: ds.getRepository(User), recorder: new AgentRunRecorder(runs, toolCalls) };
}
