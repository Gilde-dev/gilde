'use client';

import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { triggerText } from '@/lib/agent-labels';
import { agentReplacement, api, type Agent, type AgentBotUser, type AgentTools, type SlackBot } from '@/lib/api';
import { errorText, humanOnlyErrorText } from '@/lib/job-actions';
import { relativeTime } from '@/lib/time';
import { usePolling } from '@/lib/use-polling';
import { withProject } from '@/lib/use-project';
import { ActivityTab } from './agent-activity-tab';
import { PromptTab } from './agent-prompt-tab';
import { AgentStatusBadge } from './agent-status-badge';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Field } from './ui/field';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { PageHeader } from './ui/page-header';
import { Select } from './ui/select';
import { Skeleton } from './ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const POLL_MS = 30_000;

function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
    </div>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 text-sm text-danger">
      <span>{errorText(error)}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

const who = (u: { name: string | null; email: string | null; id: string }) => u.name ?? u.email ?? u.id;

/** The audit trail of one agent: who changed which field from which value to which, and when. */
function AuditTrail({ agentId, version }: { agentId: string; version: string }) {
  const load = useCallback(() => api.listAgentAudit(agentId), [agentId, version]);
  const { data, error, loading, refresh } = usePolling(load, POLL_MS);
  return (
    <section aria-label="Audit trail" className="space-y-2">
      <h3 className="text-md font-semibold">Audit trail</h3>
      {loading && !data && <Loading label="Loading audit trail" />}
      {error && !data && <LoadError error={error} onRetry={() => void refresh()} />}
      {data && data.length === 0 && <p className="text-sm text-muted-foreground">No changes yet.</p>}
      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="text-label text-muted-foreground">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Who</th>
                <th className="px-3 py-2">Field</th>
                <th className="px-3 py-2">Old</th>
                <th className="px-3 py-2">New</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="border-t border-border-subtle align-top">
                  <td className="px-3 py-2">
                    <time dateTime={e.createdAt} title={new Date(e.createdAt).toLocaleString()}>
                      {relativeTime(e.createdAt)}
                    </time>
                  </td>
                  <td className="px-3 py-2">{who(e.changedBy)}</td>
                  <td className="px-3 py-2 font-mono">{e.field}</td>
                  <td className="px-3 py-2 font-mono">{e.oldValue ?? '—'}</td>
                  <td className="px-3 py-2 font-mono">{e.newValue ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The settings form. It is keyed by `updatedAt` so a reload with newer settings resets it, and the PUT is built from the
 * latest loaded agent (full replacement) with only the edited values on top.
 */
function SettingsForm({ agent, bots, onSaved }: { agent: Agent; bots: AgentBotUser[] | undefined; onSaved: () => void | Promise<void> }) {
  const readOnly = agent.status === 'disabled_by_env';
  const [enabled, setEnabled] = useState(agent.enabled);
  const [botUserId, setBotUserId] = useState(agent.botUserId ?? '');
  const [model, setModel] = useState(agent.model ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(agent.fields.map((f) => [f.key, String(agent.settings[f.key] ?? f.default)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.replaceAgentSettings(
        agent.id,
        agentReplacement(agent, {
          enabled: agent.id === 'coding' ? true : enabled,
          botUserId: agent.hasBotUser ? botUserId || null : null,
          model: agent.hasModel ? model.trim() || null : null,
          settings: Object.fromEntries(agent.fields.map((f) => [f.key, values[f.key]?.trim() === '' ? Number.NaN : Number(values[f.key])])),
        }),
      );
      setSaved(true);
      await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // A bot user the list no longer offers (e.g. no longer marked as a bot) stays selectable so the form shows the stored value.
  const options = [...(bots ?? [])];
  if (agent.botUser && !options.some((b) => b.id === agent.botUser?.id)) options.push(agent.botUser);
  const generic = error instanceof Error && !(error as { issues?: unknown[] }).issues?.length;

  return (
    <form onSubmit={submit} aria-label="Settings" className="max-w-xl space-y-3">
      <fieldset disabled={readOnly || busy} className="space-y-3">
        {agent.id !== 'coding' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
        )}
        {agent.id === 'coding' && <p className="text-sm text-muted-foreground">Coding agents are switched off per executor, not here.</p>}
        {agent.hasBotUser && (
          <Field label="Bot user" path="botUserId" error={error} hint="Only users marked as a bot can be chosen.">
            <Select value={botUserId} onChange={(e) => setBotUserId(e.target.value)}>
              <option value="">None</option>
              {options.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.email})
                </option>
              ))}
            </Select>
          </Field>
        )}
        {agent.hasModel && (
          <Field
            label="Model"
            path="model"
            error={error}
            hint={agent.id === 'gilde' ? 'In the form openai/<model>.' : 'In the form openai/<model>. Empty follows the co-pilot’s model.'}
          >
            <Input className="font-mono" value={model} placeholder="openai/gpt-5" onChange={(e) => setModel(e.target.value)} />
          </Field>
        )}
        {agent.fields.map((f) => (
          <Field key={f.key} label={f.label} path={`settings.${f.key}`} error={error} hint={`Default ${f.default}`}>
            <Input
              type="number"
              inputMode={f.kind === 'int' ? 'numeric' : 'decimal'}
              step={f.kind === 'int' ? 1 : 'any'}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </Field>
        ))}
      </fieldset>
      {generic && (
        <p role="alert" className="text-sm text-danger">
          {humanOnlyErrorText(error, 'change agent settings')}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="text-sm text-success">
          Saved. The change is in effect now, no restart needed.
        </p>
      )}
      {!readOnly && (
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
      )}
    </form>
  );
}

function ConfigurationTab({ agent, refresh }: { agent: Agent; refresh: () => Promise<void> }) {
  const loadBots = useCallback(() => (agent.hasBotUser ? api.listAgentBotUsers() : Promise.resolve([] as AgentBotUser[])), [agent.hasBotUser]);
  const bots = usePolling(loadBots, POLL_MS);
  return (
    <div className="space-y-6">
      {agent.status === 'disabled_by_env' && (
        <p role="note" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
          Disabled by the environment{agent.reason ? `: ${agent.reason}` : ''}. The settings below are read-only here; change the server environment to switch it back on.
        </p>
      )}
      {agent.status === 'misconfigured' && agent.reason && (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
          Misconfigured: {agent.reason}. It does not run until this is fixed.
        </p>
      )}
      {agent.id === 'coding' && (
        <p className="text-sm text-muted-foreground">Dispatch settings for the lessons that are added to the job payload of every coding agent.</p>
      )}
      {bots.error && !bots.data && agent.hasBotUser && <LoadError error={bots.error} onRetry={() => void bots.refresh()} />}
      {agent.hasBotUser && !bots.data && !bots.error && <Loading label="Loading bot users" />}
      {(!agent.hasBotUser || bots.data) && <SettingsForm key={agent.updatedAt} agent={agent} bots={bots.data} onSaved={refresh} />}
      <AuditTrail agentId={agent.id} version={agent.updatedAt} />
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  'job.awaiting_review': 'A job is awaiting review',
  'job.parked': 'A job was parked',
  'job.approval_needed': 'A job needs approval',
  'revision.waiting': 'A revision proposal is waiting',
  'feature.ready_to_close': 'A feature is ready to close',
  'budget.soft': 'A budget passed its soft limit',
  'budget.hard': 'A budget reached its hard limit',
  'executor.exhausted': 'An executor ran out of usage',
  'spec.planned': 'A spec was planned',
  'spec.plan_failed': 'Planning a spec failed',
};

function SlackConfiguration({ slack }: { slack: SlackBot }) {
  return (
    <div className="space-y-6">
      <p className="max-w-prose text-sm text-muted-foreground">
        The Slack bot is the separate channels process. Gilde only sees the bot user and API key it signs in with, so it has no settings here;
        its Slack tokens and channel live in its own environment.
      </p>
      <section aria-label="Bot account" className="space-y-2">
        <h3 className="text-md font-semibold">Bot account</h3>
        {slack.botUsers.length === 0 && <p className="text-sm text-muted-foreground">No bot user has an API key.</p>}
        <ul className="space-y-1 text-sm">
          {slack.botUsers.map((b) => (
            <li key={b.id}>
              {b.name} <span className="font-mono">{b.email}</span>{' '}
              <span className="text-muted-foreground">{b.lastUsedAt ? `· key used ${relativeTime(b.lastUsedAt)}` : '· key never used'}</span>
            </li>
          ))}
        </ul>
      </section>
      <NotificationKinds kinds={slack.notificationKinds} />
    </div>
  );
}

function NotificationKinds({ kinds }: { kinds: string[] }) {
  return (
    <section aria-label="Notification kinds" className="space-y-2">
      <h3 className="text-md font-semibold">Notifications it can deliver</h3>
      <p className="text-sm text-muted-foreground">Which of these are posted is set by NOTIFICATION_KINDS in the channels environment.</p>
      <ul className="space-y-1 text-sm">
        {kinds.map((k) => (
          <li key={k}>
            <span className="font-mono">{k}</span> <span className="text-muted-foreground">· {KIND_LABEL[k] ?? ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ToolsTab({ agent }: { agent: Agent['id'] }) {
  const load = useCallback(() => api.getAgentTools(agent), [agent]);
  const { data, error, loading, refresh } = usePolling(load, POLL_MS);
  if (loading && !data) return <Loading label="Loading tools" />;
  if (error && !data) return <LoadError error={error} onRetry={() => void refresh()} />;
  if (!data) return null;
  return <ToolsList tools={data} />;
}

function ToolsList({ tools }: { tools: AgentTools }) {
  return (
    <div className="space-y-6">
      {tools.note && <p className="max-w-prose text-sm text-muted-foreground">{tools.note}</p>}
      {tools.kind === 'allowlist' && (
        <section aria-label="Tools" className="space-y-2">
          <h3 className="text-md font-semibold">Tools ({tools.tools.length})</h3>
          <ul className="divide-y divide-border-subtle rounded-lg border border-border">
            {tools.tools.map((t) => (
              <li key={t.name} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{t.name}</span>
                  <Badge variant={t.access === 'write' ? 'warning' : 'neutral'}>{t.access === 'write' ? 'Write' : 'Read'}</Badge>
                  {t.access === 'write' && <Badge variant={t.needsApproval ? 'info' : 'neutral'}>{t.needsApproval ? 'Asks for confirmation' : 'No confirmation'}</Badge>}
                </div>
                {t.description && <p className="line-clamp-2 text-sm text-muted-foreground">{t.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {tools.projectTools.length > 0 && (
        <section aria-label="Project MCP tools" className="space-y-2">
          <h3 className="text-md font-semibold">Project MCP tools</h3>
          {tools.projectTools.map((p) => (
            <div key={p.projectId} className="space-y-1">
              <h4 className="text-sm font-medium">{p.projectName}</h4>
              {p.servers.map((s) => (
                <div key={s.serverId} className="rounded-lg border border-border p-3">
                  <p className="text-sm font-medium">{s.serverName}</p>
                  <ul className="mt-1 space-y-1">
                    {s.tools.map((t) => (
                      <li key={t.name} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-mono">{t.name}</span>
                        <Badge variant={t.mode === 'write' ? 'warning' : 'neutral'}>{t.mode === 'write' ? 'Write' : 'Read'}</Badge>
                        {t.needsApproval && <Badge variant="info">Asks for confirmation</Badge>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function SlackTools({ slack }: { slack: SlackBot }) {
  return (
    <div className="space-y-6">
      <p className="max-w-prose text-sm text-muted-foreground">
        The Slack bot has no tools of its own. Chat messages are answered by the co-pilot with the co-pilot&apos;s tools, acting as the bot user
        above; the notifications are formatted without an LLM.
      </p>
      <NotificationKinds kinds={slack.notificationKinds} />
    </div>
  );
}

function Header({ title, status, project }: { title: string; status: React.ReactNode; project: string | null }) {
  return (
    <>
      <Link href={withProject('/agents', project)} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <Icon icon={ChevronLeft} size={14} />
        All agents
      </Link>
      <PageHeader title={<span className="inline-flex flex-wrap items-center gap-3">{title}{status}</span>} />
    </>
  );
}

export function AgentDetailView() {
  const params = useParams<{ id: string }>();
  const agentId = params.id;
  const project = useSearchParams().get('project');
  return agentId === 'slack' ? <SlackDetail project={project} /> : <AgentDetail agentId={agentId} project={project} />;
}

function SlackDetail({ project }: { project: string | null }) {
  const load = useCallback(() => api.getSlackBot(), []);
  const { data, error, loading, refresh } = usePolling(load, POLL_MS);
  return (
    <div className="space-y-4 p-4">
      <Header title="Slack bot" status={data && <AgentStatusBadge status={data.status} />} project={project} />
      {loading && !data && <Loading label="Loading agent" />}
      {error && !data && <LoadError error={error} onRetry={() => void refresh()} />}
      {data && (
        <>
          <p className="text-sm text-muted-foreground">{data.reason}</p>
          <Tabs defaultValue="configuration" className="space-y-4">
            <TabsList aria-label="Agent sections">
              <TabsTrigger value="configuration">Configuration</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
              <TabsTrigger value="prompt">Prompt</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="configuration"><SlackConfiguration slack={data} /></TabsContent>
            <TabsContent value="tools"><SlackTools slack={data} /></TabsContent>
            <TabsContent value="prompt"><PromptTab agent="slack" /></TabsContent>
            <TabsContent value="activity"><ActivityTab agent="slack" project={project} /></TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function AgentDetail({ agentId, project }: { agentId: string; project: string | null }) {
  const load = useCallback(() => api.getAgent(agentId), [agentId]);
  const { data: agent, error, loading, refresh } = usePolling(load, POLL_MS);
  return (
    <div className="space-y-4 p-4">
      <Header title={agent?.label ?? 'Agent'} status={agent && <AgentStatusBadge status={agent.status} />} project={project} />
      {loading && !agent && <Loading label="Loading agent" />}
      {error && !agent && <LoadError error={error} onRetry={() => void refresh()} />}
      {agent && (
        <>
          <p className="text-sm text-muted-foreground">
            {triggerText(agent.id, agent)}
            {agent.effectiveModel && (
              <>
                {' · '}
                <span className="font-mono">{agent.effectiveModel}</span>
              </>
            )}
          </p>
          <Tabs defaultValue="configuration" className="space-y-4">
            <TabsList aria-label="Agent sections">
              <TabsTrigger value="configuration">Configuration</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
              <TabsTrigger value="prompt">Prompt</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="configuration"><ConfigurationTab agent={agent} refresh={refresh} /></TabsContent>
            <TabsContent value="tools"><ToolsTab agent={agent.id} /></TabsContent>
            <TabsContent value="prompt"><PromptTab agent={agent.id} /></TabsContent>
            <TabsContent value="activity"><ActivityTab agent={agent.id} project={project} /></TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
