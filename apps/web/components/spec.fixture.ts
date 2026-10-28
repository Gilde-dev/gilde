import type { Spec, SpecDetail, SpecRecording, SpecVersion } from '@/lib/api';

export function specVersion(n: number, over: Partial<SpecVersion> = {}): SpecVersion {
  return {
    id: `v${n}`, version: n, title: `Title ${n}`, body: `## Goal\n\nBody ${n}`, bodySha256: `sha${n}`,
    criteria: [{ number: 1, id: 'AC-1', text: `Criterion ${n}` }], createdById: null, createdAt: '2026-01-01T00:00:00.000Z',
    eligibility: { eligible: true, reasons: [] }, approval: null, recording: null, ...over,
  };
}

export const approval = { id: 'ap1', approvedById: 'u1', approvedByName: 'Ann', approvedByEmail: 'ann@example.com', approvedAt: '2026-01-02T00:00:00.000Z' };

export function recording(over: Partial<SpecRecording> = {}): SpecRecording {
  return {
    id: 'rec1', jobId: 'job1', jobStatus: 'triage', jobTitle: 'Record spec dark-mode v1', prUrl: null, state: 'triage', mergedWithoutWork: false,
    dependsOnJobId: null, supersededByRecordingId: null, supersededAt: null, pinnedByFeatureId: null, createdAt: '2026-01-02T00:00:00.000Z', ...over,
  };
}

export function spec(over: Partial<Spec> = {}): Spec {
  return {
    id: 's1', projectId: 'p', repoId: 'r1', slug: 'dark-mode', title: 'Dark mode', status: 'draft', currentVersion: 2, approvedVersion: null,
    createdById: null, updatedById: null, approvedById: null, approvedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: null, ...over,
  };
}

export function specDetail(over: Partial<SpecDetail> = {}): SpecDetail {
  return {
    ...spec(), mayApprove: true, mayApproveReasons: [], eligibility: { eligible: true, reasons: [] },
    versions: [specVersion(2), specVersion(1)], ...over,
  };
}
