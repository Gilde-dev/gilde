/**
 * What a feature keeps of the approved spec version it was planned from. Written once when the feature is created, in the
 * same transaction; later drafts, approvals and recordings never change it. `body` is the exact approved text.
 */
export interface FeatureSpecPin {
    specId: string;
    specVersionId: string;
    version: number;
    slug: string;
    title: string;
    repoId: string;
    repoFullName: string;
    path: string;
    body: string;
    bodySha256: string;
    approvalId: string;
    approvedAt: string;
    approvedByName: string;
    recordingId: string;
    recordingJobId: string;
    recordingJobTitle: string;
}
