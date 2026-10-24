import type { JobStatus } from './api';

export interface Lane {
  key: string;
  title: string;
  statuses: JobStatus[];
  collapsedByDefault?: boolean;
}

export const LANES: Lane[] = [
  { key: 'queued', title: 'Queued', statuses: ['queued'] },
  { key: 'running', title: 'Running', statuses: ['dispatched'] },
  { key: 'pr_open', title: 'PR open', statuses: ['pr_open'] },
  { key: 'awaiting_review', title: 'Awaiting review', statuses: ['awaiting_review'] },
  { key: 'parked', title: 'Parked', statuses: ['parked'] },
  { key: 'done', title: 'Done', statuses: ['merged', 'rejected', 'cancelled'], collapsedByDefault: true },
];
