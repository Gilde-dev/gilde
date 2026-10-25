'use client';

import { CopilotKit, useCopilotReadable } from '@copilotkit/react-core';
import { CopilotSidebar } from '@copilotkit/react-ui';
import '@copilotkit/react-ui/styles.css';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { CopilotPlanApproval } from '@/components/copilot-plan-approval';
import { CopilotBusyIndicator, CopilotToolRenderers, GroupedMessage } from '@/components/copilot-tool-renderers';
import { api } from '@/lib/api';

/** Same-origin proxy route; it adds the session token, so the browser never holds a token or an LLM key. */
export const COPILOT_RUNTIME_URL = '/api/gilde/v1/mastra/copilotkit';
export const COPILOT_AGENT = 'gilde';

const EnabledContext = createContext(false);

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
