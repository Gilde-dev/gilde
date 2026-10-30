'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type AgentBotUser } from '@/lib/api';
import { errorText, humanOnlyErrorText } from '@/lib/job-actions';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';

/** `werkmeester@<domain of the current user>`; just the local part when the domain is unknown. */
function suggestedEmail(name: string, currentEmail: string | null): string {
  const local = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const domain = currentEmail?.split('@')[1];
  return domain ? `${local}@${domain}` : '';
}

/**
 * "Create bot user" for the agent settings: creates the account through the API and hands it to `onCreated` so the form can
 * select it. Saving the agent's settings stays a separate, audited step.
 */
export function CreateBotUserAction({ suggestedName, disabled, onCreated }: {
  suggestedName: string;
  disabled?: boolean;
  onCreated: (bot: AgentBotUser) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(suggestedName);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Prefill the email from the signed-in user's domain each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setName(suggestedName);
    setEmail('');
    setError(null);
    api.me().then((me) => live && setEmail((cur) => cur || suggestedEmail(suggestedName, me.email)), () => undefined);
    return () => {
      live = false;
    };
  }, [open, suggestedName]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // The dialog is a portal child of the settings form; keep its submit from reaching that form's handler.
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      const bot = await api.createBotUser({ name: name.trim(), email: email.trim() });
      onCreated({ id: bot.id, name: bot.name, email: bot.email });
      setOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const generic = error !== null && !(error instanceof ApiError && error.issues.length > 0);

  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        Create bot user
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(28rem,92vw)]">
          <DialogTitle>Create bot user</DialogTitle>
          <DialogDescription>
            Bots never sign in; Gilde generates a password nobody sees. The new bot is selected in the form, and takes effect when you save the settings.
          </DialogDescription>
          <form onSubmit={submit} aria-label="Create bot user" className="mt-4 space-y-3">
            <Field label="Name" path="name" error={error}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" path="email" error={error}>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            {generic && (
              <p role="alert" className="text-sm text-danger">
                {(error as { status?: number }).status === 409 ? errorText(error) : humanOnlyErrorText(error, 'create bot users')}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
