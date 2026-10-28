import { useCallback } from 'react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { BudgetBar } from './budget-bar';

const POLL_MS = 30_000;

/**
 * Estimated spend of the CURRENT UTC day and ISO week for the project and globally. Independent of the metrics
 * period and repo filters: the API's current periods are shown as they are.
 */
export function BudgetSection({ projectId }: { projectId: string }) {
  const fetchBudget = useCallback(() => api.getBudget(projectId), [projectId]);
  const budget = usePolling(fetchBudget, POLL_MS);
  // The first render after a project switch still holds the previous project's data.
  const data = budget.data?.project?.projectId === projectId ? budget.data : undefined;
  return (
    <section aria-label="Estimated budget" className="space-y-3 p-4">
      <div>
        <h3 className="text-md font-semibold">Estimated budget</h3>
        <p className="text-sm text-muted-foreground">
          Current UTC day and ISO week, regardless of the period and repo filters. Amounts are estimated; with a subscription they are notional
          consumption, not a bill. Recorded spend only: delayed telemetry and running work can overshoot.
        </p>
      </div>
      {!data && budget.error && (
        <p role="alert" className="text-sm text-danger">
          Budget could not be loaded: {budget.error.message}
        </p>
      )}
      {!data && !budget.error && <p className="text-sm text-muted-foreground">Loading budget…</p>}
      {data && (
        <ul className="grid gap-3 md:grid-cols-2">
          <BudgetBar status={data.project!.day} />
          <BudgetBar status={data.project!.week} />
          <BudgetBar status={data.global.day} />
          <BudgetBar status={data.global.week} />
        </ul>
      )}
    </section>
  );
}
