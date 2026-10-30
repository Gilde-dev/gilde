'use client';

import { useCallback, useState, type FormEvent } from 'react';
import { api, ApiError, type AdminUser, type SetupLink } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { usePolling } from '@/lib/use-polling';
import { CreateBotUserAction } from './create-bot-user-dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { PageHeader } from './ui/page-header';

const formatDate = (iso: string) => new Date(iso).toLocaleString();

/** 403 gets its own wording; a 409 shows the API's message (last admin, self, duplicate email). */
function userErrorText(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  return status === 403 ? 'Only admins can manage users.' : errorText(e);
}

type Confirm = { kind: 'deactivate' | 'reactivate'; user: AdminUser };

export function UsersView() {
  const me = usePolling(api.me, 300_000);
  const isAdmin = me.data?.isAdmin === true;
  const fetchUsers = useCallback(() => (isAdmin ? api.listUsers() : Promise.resolve([] as AdminUser[])), [isAdmin]);
  const users = usePolling(fetchUsers, 30_000);
  const [link, setLink] = useState<SetupLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me.loading && !me.data) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (me.error && !me.data) return <p role="alert" className="p-4 text-sm text-danger">{me.error.message}</p>;
  if (!isAdmin) {
    return (
      <>
        <PageHeader className="px-4 pt-4" title="Users" />
        <p role="note" className="p-4 text-sm text-muted-foreground">Admins only. Ask an admin if you need a user managed.</p>
      </>
    );
  }

  const list = users.data ?? [];
  const activeAdmins = list.filter((u) => u.isAdmin && !u.deactivatedAt).length;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(userErrorText(e));
    } finally {
      await users.refresh();
      setBusy(false);
    }
  }

  const showLink = (l: SetupLink) => {
    setLink(l);
    setCopied(false);
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.setupLink);
      setCopied(true);
    } catch {
      setError('Could not copy; select the link and copy it manually.');
    }
  };

  const doConfirm = async () => {
    if (!confirm) return;
    const { kind, user } = confirm;
    await run(() => (kind === 'deactivate' ? api.deactivateUser(user.id) : api.reactivateUser(user.id)));
    setConfirm(null);
  };

  return (
    <>
      <PageHeader
        className="px-4 pt-4"
        title="Users"
        description="Create accounts with a one-time setup link, reset passwords and manage admins. Users are deactivated, never deleted."
        actions={
          <div className="flex gap-2">
            <Button onClick={() => setInviting(true)}>Create user</Button>
            <CreateBotUserAction suggestedName="" onCreated={() => void users.refresh()} />
          </div>
        }
      />
      {error && <p role="alert" className="px-4 pt-3 text-sm text-danger">{error}</p>}
      {link && (
        <section aria-label="Setup link" className="m-4 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
          <p className="font-medium">
            Copy this link for {link.user.name} now. It is shown only once, works once and expires {formatDate(link.expiresAt)}.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-background px-2 py-1">{link.setupLink}</code>
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setLink(null)}>
              Done
            </Button>
          </div>
        </section>
      )}
      {users.loading && !users.data && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
      {users.error && !users.data && <p role="alert" className="px-4 pt-3 text-sm text-danger">{userErrorText(users.error)}</p>}
      {users.data && (
        <table className="m-4 w-[calc(100%-2rem)] text-left text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Name</th>
              <th className="py-1 font-medium">Email</th>
              <th className="py-1 font-medium">Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((u) => {
              const self = u.id === me.data?.id;
              const deactivated = u.deactivatedAt !== null;
              const lastAdmin = u.isAdmin && !deactivated && activeAdmins <= 1;
              const deactivateReason = self ? 'You cannot deactivate yourself' : lastAdmin ? 'The last admin cannot be deactivated' : undefined;
              const adminReason = lastAdmin ? 'The last admin cannot be removed' : deactivated ? 'Reactivate the user first' : undefined;
              const reasons = u.isBot ? [] : [deactivated ? undefined : deactivateReason, deactivated ? undefined : adminReason].filter(Boolean);
              return (
                <tr key={u.id} className="border-t border-border align-top">
                  <td className="py-2">
                    <span className="mr-2">{u.name}</span>
                    {u.isAdmin && <Badge variant="accent">admin</Badge>} {u.isBot && <Badge>bot</Badge>} {deactivated && <Badge variant="danger">deactivated</Badge>}
                  </td>
                  <td className="py-2">{u.email}</td>
                  <td className="py-2">{formatDate(u.createdAt)}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap justify-end gap-2">
                      {!u.isBot && !deactivated && (
                        <Button size="sm" variant="outline" disabled={busy} aria-label={`Reset link for ${u.name}`} onClick={() => void run(async () => showLink(await api.createUserResetLink(u.id)))}>
                          Reset link
                        </Button>
                      )}
                      {!u.isBot && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || Boolean(adminReason)}
                          title={adminReason}
                          aria-label={`${u.isAdmin ? 'Remove admin' : 'Make admin'} ${u.name}`}
                          onClick={() => void run(() => api.setUserAdmin(u.id, !u.isAdmin))}
                        >
                          {u.isAdmin ? 'Remove admin' : 'Make admin'}
                        </Button>
                      )}
                      {deactivated ? (
                        <Button size="sm" variant="outline" disabled={busy} aria-label={`Reactivate ${u.name}`} onClick={() => setConfirm({ kind: 'reactivate', user: u })}>
                          Reactivate
                        </Button>
                      ) : (
                        <Button size="sm" variant="danger" disabled={busy || Boolean(deactivateReason)} title={deactivateReason} aria-label={`Deactivate ${u.name}`} onClick={() => setConfirm({ kind: 'deactivate', user: u })}>
                          Deactivate
                        </Button>
                      )}
                    </div>
                    {reasons.length > 0 && <p className="mt-1 text-right text-label text-muted-foreground">{reasons.join('. ')}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        onCreated={(l) => {
          showLink(l);
          void users.refresh();
        }}
      />
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="w-[min(28rem,92vw)]">
          <DialogTitle>{confirm?.kind === 'deactivate' ? `Deactivate ${confirm.user.name}?` : `Reactivate ${confirm?.user.name}?`}</DialogTitle>
          <DialogDescription>
            {confirm?.kind === 'deactivate'
              ? 'They can no longer log in, their sessions and API keys stop working and their executors stop. Their history (jobs, specs, runs) stays.'
              : 'They can log in again with their existing password. API keys and executors work again.'}
          </DialogDescription>
          <div className="mt-4 flex gap-2">
            <Button variant={confirm?.kind === 'deactivate' ? 'danger' : 'primary'} disabled={busy} onClick={() => void doConfirm()}>
              {confirm?.kind === 'deactivate' ? 'Deactivate' : 'Reactivate'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InviteDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (l: SetupLink) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.inviteUser({ name: name.trim(), email: email.trim() }));
      setName('');
      setEmail('');
      onOpenChange(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const generic = error !== null && !(error instanceof ApiError && error.issues.length > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(28rem,92vw)]">
        <DialogTitle>Create user</DialogTitle>
        <DialogDescription>The user gets no password: you receive a one-time setup link (valid 24 hours) to hand over.</DialogDescription>
        <form onSubmit={submit} aria-label="Create user" className="mt-4 space-y-3">
          <Field label="Name" path="name" error={error}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" path="email" error={error}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {generic && (
            <p role="alert" className="text-sm text-danger">
              {userErrorText(error)}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
