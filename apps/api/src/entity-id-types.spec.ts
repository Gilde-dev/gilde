import { DataSource } from 'typeorm';

/**
 * Every id in Gilde is a uuid. A column holding another row's id must be uuid too, or Postgres rejects joins and
 * comparisons with "operator does not exist: uuid = character varying" (SQLite does not notice).
 */

/** Columns that end in _id but hold ids from outside Gilde (GitHub, Claude sessions, Mastra) or derived keys. */
const EXTERNAL_IDS = new Set([
  'feedback.github_id',
  'feedback.review_id',
  'job_runs.session_id',
  'agent_usage.session_id',
  'agent_usage.organization_id',
  'llm_usage.thread_id',
  'history_entries.source_id',
  'history_entries.project_id',
  'history_state.pass_id',
  'webhook_deliveries.delivery_id',
]);

const REFERENCE_COLUMN = /(_id|_by)$/;

async function entityMetadatas() {
  const modules = import.meta.glob<Record<string, unknown>>('./**/*.entity.ts', { eager: true });
  const entities = Object.values(modules).flatMap((m) => Object.values(m).filter((v) => typeof v === 'function'));
  const dataSource = new DataSource({ type: 'postgres', entities: entities as never[] });
  // Builds entity metadata from the decorators without connecting.
  await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  return dataSource.entityMetadatas;
}

describe('entity id column types', () => {
  it('stores references to Gilde rows as uuid', async () => {
    const metadatas = await entityMetadatas();
    expect(metadatas.length).toBeGreaterThan(10);

    const wrong = metadatas.flatMap((meta) =>
      meta.columns
        .filter((col) => REFERENCE_COLUMN.test(col.databaseName))
        .map((col) => ({ name: `${meta.tableName}.${col.databaseName}`, type: String(col.type) }))
        .filter(({ name, type }) => !EXTERNAL_IDS.has(name) && type !== 'uuid'),
    );

    expect(wrong).toEqual([]);
  });
});
