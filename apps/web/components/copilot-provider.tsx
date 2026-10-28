'use client';

import { CopilotKit, useCopilotReadable } from '@copilotkit/react-core';
import { CopilotSidebar } from '@copilotkit/react-ui';
import '@copilotkit/react-ui/styles.css';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { CopilotPlanApproval } from '@/components/copilot-plan-approval';
import { CopilotBusyIndicator, CopilotToolRenderers, GroupedMessage } from '@/components/copilot-tool-renderers';
import { api, type BudgetPeriodStatus, type BudgetStatus } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';

/** Same-origin proxy route; it adds the session token, so the browser never holds a token or an LLM key. */
export const COPILOT_RUNTIME_URL = '/api/gilde/v1/mastra/copilotkit';
export const COPILOT_AGENT = 'gilde';

const EnabledContext = createContext(false);

const BUDGET_POLL_MS = 60_000;

const usd = (n: number) => `$${n.toFixed(2)}`;
const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function describePeriod(p: BudgetPeriodStatus): string {
  const name = `${p.period === 'day' ? 'Daily' : 'Weekly'}`;
  if (p.reason?.kind === 'configError') return `${name}: ${p.reason.variable ?? 'the limit setting'} is invalid`;
  const percent = p.percent === null ? '' : ` (${Math.floor(p.percent)}%)`;
  return `${name}: ${usd(p.spent)} of ${p.limit === null ? 'no limit' : usd(p.limit)} estimated${percent}, resets ${utc(p.resetsAt)}`;
}

/**
 * Nonblocking notice about the GLOBAL estimated budget next to the co-pilot. It never disables, remounts or gates chat:
 * human use stays available at any budget state, and a failed lookup shows nothing (never a claim about spend).
 * Rendered only for logged-in pages, so /login does not poll.
 */
export function CopilotBudgetWarning() {
  const load = useCallback(() => api.getBudget(), []);
  const { data } = usePolling<BudgetStatus>(load, BUDGET_POLL_MS);
  if (!data) return null;
  const periods = [data.global.day, data.global.week].filter((p) => p.state !== 'ok');
  if (periods.length === 0) return null;
  const hard = periods.some((p) => p.state === 'hard');
  return (
    <div
      role="status"
      aria-label="Global budget"
      className={`fixed bottom-3 left-3 z-40 max-w-sm rounded-md border px-3 py-2 text-sm shadow-sm ${
        hard ? 'border-danger/40 bg-danger-soft text-danger' : 'border-warning/40 bg-warning-soft text-warning'
      }`}
    >
      <p className="font-medium">{hard ? 'Global estimated budget reached' : 'Global estimated budget warning'}</p>
      <ul className="mt-1 space-y-0.5">
        {periods.map((p) => (
          <li key={p.period}>{describePeriod(p)}</li>
        ))}
      </ul>
      <p className="mt-1">
        {hard
          ? `New automatic dispatch is stopped${data.recovery === 'reset' && data.recoversAt ? ` until ${utc(data.recoversAt)} at the earliest` : ' until the limit or configuration changes'}. `
          : ''}
        The co-pilot and the rest of Gilde stay available.
      </p>
    </div>
  );
}

/**
 * Wraps the app with the co-pilot sidebar (collapsed by default). It is not rendered on /login, and when the API
 * says the co-pilot is not configured a small note replaces the sidebar.
 */
export function CopilotProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onLogin = pathname === '/login';
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (onLogin) return;
    let cancelled = false;
    api
      .copilotStatus()
      .then((s) => !cancelled && setEnabled(s.enabled))
      .catch(() => !cancelled && setEnabled(false));
    return () => {
      cancelled = true;
    };
  }, [onLogin]);

  if (onLogin || enabled === null) return <>{children}</>;

  if (!enabled) {
    return (
      <>
        {children}
        <CopilotBudgetWarning />
        <p
          role="status"
          className="fixed bottom-3 right-3 z-40 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground shadow-sm"
        >
          Co-pilot not configured
        </p>
      </>
    );
  }

  return (
    <EnabledContext.Provider value>
      <CopilotKit runtimeUrl={COPILOT_RUNTIME_URL} agent={COPILOT_AGENT} useSingleEndpoint>
        <CopilotPlanApproval />
        <CopilotToolRenderers />
        <CopilotBusyIndicator />
        <CopilotSidebar defaultOpen={false} labels={{ title: 'Gilde co-pilot' }} RenderMessage={GroupedMessage}>
          {children}
        </CopilotSidebar>
        <CopilotBudgetWarning />
      </CopilotKit>
    </EnabledContext.Provider>
  );
}

function Readable({ description, value }: { description: string; value: unknown }) {
  useCopilotReadable({ description, value });
  return null;
}

/**
 * Tells the co-pilot what the user is looking at (a selected project, an open job or feature).
 * Renders nothing, and does nothing when the co-pilot is disabled or not mounted (login, tests).
 */
export function CopilotPageContext({ description, value }: { description: string; value: unknown }) {
  const enabled = useContext(EnabledContext);
  return enabled ? <Readable description={description} value={value} /> : null;
}
