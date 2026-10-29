import type { AgentStatus } from '@/lib/api';
import { Badge, type BadgeVariant } from './ui/badge';

const STATUS: Record<AgentStatus, { label: string; variant: BadgeVariant }> = {
  on: { label: 'On', variant: 'success' },
  off: { label: 'Off', variant: 'neutral' },
  misconfigured: { label: 'Misconfigured', variant: 'danger' },
  disabled_by_env: { label: 'Disabled by the environment', variant: 'warning' },
};

/** The status of an agent or bot; always the same words, never raw status text. */
export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const { label, variant } = STATUS[status];
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  );
}
