import Link from 'next/link';
import { EmptyState } from './ui/empty-state';

/** Shown by project views when there is no project to show. */
export function NoProjects() {
  return (
    <div className="p-4">
      <EmptyState
        title="No projects yet"
        text="Create a project to start queueing jobs."
        action={
          <Link href="/settings/projects" className="text-sm font-medium text-accent underline-offset-2 hover:underline">
            Go to project settings
          </Link>
        }
      />
    </div>
  );
}
