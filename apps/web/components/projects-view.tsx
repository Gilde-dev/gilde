'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { api, type ApiError, type Project } from '@/lib/api';
import { errorText } from '@/lib/job-actions';
import { usePolling } from '@/lib/use-polling';
import { useProject, withProject } from '@/lib/use-project';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { EmptyState } from './ui/empty-state';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { PageHeader } from './ui/page-header';
import { Textarea } from './ui/textarea';

const POLL_MS = 30_000;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function RepoCount({ projectId }: { projectId: string }) {
  const fetchRepos = useCallback(() => api.listRepos(projectId), [projectId]);
  const repos = usePolling(fetchRepos, POLL_MS);
  return <>{repos.data ? repos.data.length : '…'}</>;
}

export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        name: name.trim(),
        slug,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setName('');
      setSlug('');
      setSlugEdited(false);
      setDescription('');
      await onCreated(project);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(28rem,92vw)]">
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>A project groups repos, jobs and features.</DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="Name" path="name" error={error}>
            <Input
              value={name}
              maxLength={100}
              required
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) setSlug(slugify(e.target.value));
              }}
            />
          </Field>
          <Field label="Slug" path="slug" error={error} hint="Lowercase letters, digits and dashes.">
            <Input
              value={slug}
              required
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
            />
          </Field>
          <Field label="Description" path="description" error={error}>
            <Textarea value={description} maxLength={2000} rows={3} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {error != null && (error as ApiError).issues?.length === 0 && (
            <p role="alert" className="text-sm text-danger">
              {errorText(error)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !slug}>
              Create project
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsView() {
  const router = useRouter();
  const { projects, projectId, setProjectId, error, refresh } = useProject();
  const [creating, setCreating] = useState(false);

  const created = async (project: Project) => {
    await refresh();
    setCreating(false);
    setProjectId(project.id);
    router.push(withProject(`/settings/projects/${project.id}`, project.id));
  };

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Projects"
        description="Products that Gilde builds. Each has its own repos, jobs, features and policies."
        actions={<Button onClick={() => setCreating(true)}>New project</Button>}
      />
      {error && <p className="text-sm text-danger">{error.message}</p>}
      {projects?.length === 0 && (
        <EmptyState title="No projects yet" text="Create a project to add repos and queue jobs." />
      )}
      {projects && projects.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Slug</th>
                <th className="px-3 py-2">Repos</th>
                <th className="px-3 py-2">Daily run limit</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link
                      href={withProject(`/settings/projects/${p.id}`, p.id)}
                      className="font-medium text-foreground hover:underline"
                    >
                      {p.name}
                    </Link>
                    {p.id === projectId && <span className="ml-2 text-xs text-muted-foreground">selected</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{p.slug}</td>
                  <td className="px-3 py-2">
                    <RepoCount projectId={p.id} />
                  </td>
                  <td className="px-3 py-2">{p.dailyRunLimit}</td>
                  <td className="px-3 py-2">{p.paused && <Badge variant="warning">paused</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} onCreated={created} />
    </div>
  );
}
