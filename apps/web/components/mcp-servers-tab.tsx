'use client';

import { Plus, Plug } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  mcpServerReplacement,
  type McpAuditEntry,
  type McpServer,
  type McpTestResult,
  type McpTool,
  type McpToolMode,
} from '@/lib/api';
import { humanOnlyErrorText } from '@/lib/job-actions';
import { usePolling } from '@/lib/use-polling';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { EmptyState } from './ui/empty-state';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { Select } from './ui/select';
import { Skeleton } from './ui/skeleton';

const formatDate = (iso: string) => new Date(iso).toLocaleString();
const isNotConfigured = (e: unknown) => e instanceof ApiError && e.status === 503;
const maskedToken = (s: McpServer) => (s.hasToken && s.tokenLast4 ? `••••${s.tokenLast4}` : 'no token');

const ERROR_KIND_LABEL: Record<NonNullable<McpTestResult['errorKind']>, string> = {
  unreachable: 'Unreachable',
  timeout: 'Timed out',
  auth: 'Authentication failed',
  not_mcp: 'Not an MCP server',
};

const AUDIT_LABEL: Record<McpAuditEntry['action'], string> = {
  created: 'Created',
  updated: 'Updated',
  token_replaced: 'Token replaced',
  tested: 'Tested',
  tools_updated: 'Tools updated',
  deleted: 'Deleted',
};

function NotConfigured() {
  return (
    <p role="alert" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
      MCP servers are not configured on the server: <code className="font-mono">EXECUTOR_SECRET_KEY</code> is missing. Ask the
      administrator to set it before adding a server.
    </p>
  );
}

function ErrorText({ error }: { error: unknown }) {
  if (error == null || (error instanceof ApiError && error.issues.length > 0)) return null;
  if (isNotConfigured(error)) return <NotConfigured />;
  return (
    <p role="alert" className="text-sm text-danger">
      {humanOnlyErrorText(error, 'change MCP servers')}
    </p>
  );
}

/** Add (no `server`) or edit. Edit sends the full PUT body built from the latest loaded server; the token is replaced separately. */
function ServerDialog({
  projectId,
  server,
  latest,
  onClose,
  onSaved,
}: {
  projectId: string;
  server?: McpServer;
  /** The latest loaded copy of `server`, which the full PUT is built from. */
  latest?: McpServer;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [unattended, setUnattended] = useState(server?.unattendedEnabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    try {
      if (server) {
        await api.replaceMcpServer(
          projectId,
          server.id,
          mcpServerReplacement(latest ?? server, { name: name.trim(), url: url.trim(), enabled, unattendedEnabled: unattended }),
        );
      } else {
        const token = String(new FormData(form).get('token') ?? '').trim();
        await api.createMcpServer(projectId, {
          name: name.trim(),
          url: url.trim(),
          ...(token ? { token } : {}),
          enabled,
          unattendedEnabled: unattended,
        });
        form.reset();
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(32rem,92vw)]">
        <DialogTitle>{server ? `Edit ${server.name}` : 'Add MCP server'}</DialogTitle>
        <DialogDescription>
          {server ? 'Settings of this server. The token is replaced separately.' : 'A remote MCP server (Streamable HTTP, https only).'}
        </DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="Name" path="name" error={error} hint="Tools are namespaced with it, for example notion.search.">
            <Input value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Server URL" path="url" error={error}>
            <Input className="font-mono" value={url} required placeholder="https://mcp.example.com/mcp" onChange={(e) => setUrl(e.target.value)} />
          </Field>
          {!server && (
            <Field label="Token" path="token" error={error} hint="Optional. Stored encrypted and never shown again.">
              <Input name="token" type="password" autoComplete="off" />
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={unattended} onChange={(e) => setUnattended(e.target.checked)} />
            <span>
              Available to unattended agents
              <span className="block text-muted-foreground">
                The Verkenner and Verfijner may use the read tools of this server. Off by default; writing tools are never available to them.
              </span>
            </span>
          </label>
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !url.trim()}>
              {server ? 'Save' : 'Add server'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Replaces the token. The value is read from the form on submit and never prefilled or kept in state. */
function TokenDialog({ projectId, server, onClose, onSaved }: { projectId: string; server: McpServer; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const token = String(new FormData(form).get('token') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api.replaceMcpServerToken(projectId, server.id, token);
      form.reset();
      await onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(28rem,92vw)]">
        <DialogTitle>Replace token of {server.name}</DialogTitle>
        <DialogDescription>The current token is never shown. The new one is stored encrypted.</DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="New token" path="token" error={error}>
            <Input name="token" type="password" autoComplete="off" required />
          </Field>
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Replace token
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ projectId, server, onClose, onDeleted }: { projectId: string; server: McpServer; onClose: () => void; onDeleted: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteMcpServer(projectId, server.id);
      await onDeleted();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(26rem,92vw)]">
        <DialogTitle>Delete {server.name}?</DialogTitle>
        <DialogDescription>Its token and allowlist are removed. Agents can no longer use its tools.</DialogDescription>
        <div className="mt-4 space-y-3">
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={confirm}>
              Delete
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Tools of one server: the last loaded or tested list with a mode and an Allowed checkbox per tool, and the audit list. */
function ServerPanel({ projectId, server, onChanged }: { projectId: string; server: McpServer; onChanged: () => void | Promise<void> }) {
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [audit, setAudit] = useState<McpAuditEntry[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [testing, setTesting] = useState(false);
  const [testFailure, setTestFailure] = useState<McpTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const detail = await api.getMcpServer(projectId, server.id);
      setTools(detail.tools);
      setAudit(detail.audit);
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [projectId, server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(t);
  }, [saved]);

  const test = async () => {
    setTesting(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api.testMcpServer(projectId, server.id);
      setTestFailure(result.ok ? null : result);
      setTools(result.tools);
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setError(err);
    } finally {
      setTesting(false);
    }
  };

  const update = (name: string, change: Partial<Pick<McpTool, 'mode' | 'allowed'>>) =>
    setTools((all) => all.map((t) => (t.name === name ? { ...t, ...change } : t)));

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api.replaceMcpServerTools(
        projectId,
        server.id,
        tools.map((t) => ({ name: t.name, mode: t.mode, allowed: t.allowed })),
      );
      setTools(result);
      setSaved(true);
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const allowedCount = tools.filter((t) => t.allowed).length;

  return (
    <div className="space-y-4 border-t border-border-subtle pt-3">
      <section aria-label={`Tools of ${server.name}`} className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-md font-semibold">Tools</h3>
          <Button size="sm" variant="outline" disabled={testing} onClick={() => void test()}>
            Test connection
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Nothing is usable until it is allowed. Read tools run directly; write tools only run in the co-pilot after you confirm each call, and
          never for unattended agents (the Verkenner and Verfijner). Tools that are not annotated as read-only start as write.
        </p>
        {testFailure && (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
            {testFailure.errorKind ? `${ERROR_KIND_LABEL[testFailure.errorKind]}: ` : ''}
            {testFailure.message ?? 'The connection test failed.'}
          </p>
        )}
        {loading && <Skeleton className="h-16" />}
        {!loading && loadError != null && <ErrorText error={loadError} />}
        {!loading && loadError == null && tools.length === 0 && (
          <p className="text-sm text-muted-foreground">No tools yet. Test the connection to list the tools of this server.</p>
        )}
        {tools.length > 0 && (
          <ul className="divide-y divide-border-subtle rounded-lg border border-border">
            {tools.map((t) => (
              <li key={t.name} className="flex flex-wrap items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm">{t.name}</p>
                  {t.description && <p className="text-sm text-muted-foreground">{t.description}</p>}
                </div>
                <Select
                  aria-label={`Mode of ${t.name}`}
                  className="w-28"
                  value={t.mode}
                  onChange={(e) => update(t.name, { mode: e.target.value as McpToolMode })}
                >
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                </Select>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`Allow ${t.name}`}
                    checked={t.allowed}
                    onChange={(e) => update(t.name, { allowed: e.target.checked })}
                  />
                  Allowed
                </label>
              </li>
            ))}
          </ul>
        )}
        <ErrorText error={error} />
        {tools.length > 0 && (
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              Save allowlist
            </Button>
            <span className="text-sm text-muted-foreground">
              {allowedCount} of {tools.length} allowed
            </span>
            {saved && (
              <span role="status" className="text-sm text-success">
                Saved
              </span>
            )}
          </div>
        )}
      </section>
      <section aria-label={`Audit of ${server.name}`} className="space-y-2">
        <h3 className="text-md font-semibold">Audit</h3>
        {!loading && audit.length === 0 && <p className="text-sm text-muted-foreground">No changes recorded yet.</p>}
        {audit.length > 0 && (
          <ul className="space-y-1 text-sm">
            {audit.map((a) => (
              <li key={a.id}>
                <span className="font-medium">{AUDIT_LABEL[a.action] ?? a.action}</span>
                <span className="text-muted-foreground">
                  {' '}
                  by {a.actorEmail} · {formatDate(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type Dialogs = { kind: 'add' } | { kind: 'edit' | 'token' | 'delete'; id: string } | null;

export function McpServersTab({ projectId }: { projectId: string }) {
  const fetchServers = useCallback(() => api.listMcpServers(projectId), [projectId]);
  const servers = usePolling(fetchServers, 30_000);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const list = servers.data;
  const current = dialog && dialog.kind !== 'add' ? list?.find((x) => x.id === dialog.id) : undefined;
  const close = () => setDialog(null);

  const toggle = async (id: string) => {
    // Built from the latest loaded server, not from a copy captured when the row rendered.
    const latest = servers.data?.find((x) => x.id === id);
    if (!latest) return;
    setActionError(null);
    try {
      await api.replaceMcpServer(projectId, id, mcpServerReplacement(latest, { enabled: !latest.enabled }));
    } catch (err) {
      setActionError(err);
    }
    await servers.refresh();
  };

  const addButton = (
    <Button icon={Plus} onClick={() => setDialog({ kind: 'add' })}>
      Add server
    </Button>
  );

  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Remote MCP servers (a knowledge base, Notion, an issue tracker) whose allowed tools Gilde&apos;s agents can use for this project.
          Results are always treated as untrusted data.
        </p>
        {list && list.length > 0 && addButton}
      </div>
      {actionError != null && <ErrorText error={actionError} />}
      {servers.loading && !list && (
        <div role="status" aria-label="Loading MCP servers" className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}
      {servers.error && !list && (
        <div className="flex flex-wrap items-center gap-3">
          <ErrorText error={servers.error} />
          <Button size="sm" variant="outline" onClick={() => void servers.refresh()}>
            Retry
          </Button>
        </div>
      )}
      {list && list.length === 0 && (
        <EmptyState icon={Plug} title="No MCP servers yet" text="Add a server to give the agents of this project more context." action={addButton} />
      )}
      {list?.map((x) => (
        <article key={x.id} aria-label={x.name} className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-md font-semibold">{x.name}</h2>
            <Badge variant={x.enabled ? 'success' : 'neutral'} dot>
              {x.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <Badge variant={x.unattendedEnabled ? 'accent' : 'neutral'}>
              {x.unattendedEnabled ? 'Unattended agents: yes' : 'Unattended agents: no'}
            </Badge>
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">URL</dt>
              <dd className="break-all font-mono">{x.url}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Token</dt>
              <dd className="font-mono">{maskedToken(x)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Calls / errors</dt>
              <dd>
                {x.callCount} calls, {x.errorCount} errors
              </dd>
            </div>
            {x.lastError && (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Last error{x.lastErrorAt ? ` (${formatDate(x.lastErrorAt)})` : ''}</dt>
                <dd className="text-danger">{x.lastError}</dd>
              </div>
            )}
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'edit', id: x.id })} aria-label={`Edit ${x.name}`}>
              Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'token', id: x.id })} aria-label={`Replace token of ${x.name}`}>
              Replace token
            </Button>
            <Button size="sm" variant="outline" onClick={() => void toggle(x.id)} aria-label={`${x.enabled ? 'Disable' : 'Enable'} ${x.name}`}>
              {x.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-expanded={open === x.id}
              onClick={() => setOpen(open === x.id ? null : x.id)}
              aria-label={`Tools and audit of ${x.name}`}
            >
              {open === x.id ? 'Hide tools and audit' : 'Tools and audit'}
            </Button>
            <Button size="sm" variant="danger" onClick={() => setDialog({ kind: 'delete', id: x.id })} aria-label={`Delete ${x.name}`}>
              Delete
            </Button>
          </div>
          {open === x.id && <ServerPanel projectId={projectId} server={x} onChanged={servers.refresh} />}
        </article>
      ))}
      {dialog?.kind === 'add' && <ServerDialog projectId={projectId} onClose={close} onSaved={servers.refresh} />}
      {dialog?.kind === 'edit' && current && (
        <ServerDialog projectId={projectId} server={current} latest={current} onClose={close} onSaved={servers.refresh} />
      )}
      {dialog?.kind === 'token' && current && <TokenDialog projectId={projectId} server={current} onClose={close} onSaved={servers.refresh} />}
      {dialog?.kind === 'delete' && current && <DeleteDialog projectId={projectId} server={current} onClose={close} onDeleted={servers.refresh} />}
    </div>
  );
}
