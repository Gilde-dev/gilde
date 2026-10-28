import { z } from 'zod';

import { JOB_STATUSES } from '../job/job-state.js';
import { SPEC_STATUSES } from './spec.entity.js';

/** Largest body in characters; leaves room for the recording job's task (limit 40,000 together with its criteria). */
export const SPEC_BODY_MAX = 30_000;

const slug = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use kebab-case: lowercase letters and digits separated by single dashes');
const title = z.string().trim().min(3).max(200);
/** Not trimmed or normalised: the body is stored byte for byte. */
const body = z.string().min(1).max(SPEC_BODY_MAX);

/** The actor is never in the body: it comes from the authenticated request. Unknown fields are rejected. */
export const CreateSpecSchema = z.strictObject({
    repoId: z.string().uuid(),
    slug,
    title,
    body,
    /** A new spec has no version yet. */
    expectedVersion: z.number().int().min(0),
});

export const SaveSpecVersionSchema = z.strictObject({
    title,
    body,
    expectedVersion: z.number().int().min(1),
});

export const ApproveSpecSchema = z.strictObject({
    expectedVersion: z.number().int().min(1),
});

export type CreateSpecDto = z.infer<typeof CreateSpecSchema>;
export type SaveSpecVersionDto = z.infer<typeof SaveSpecVersionSchema>;
export type ApproveSpecDto = z.infer<typeof ApproveSpecSchema>;

export const SpecCriterionSchema = z.object({
    number: z.number().int().positive(),
    id: z.string(),
    text: z.string(),
});

export const SpecApprovalEvidenceSchema = z.object({
    id: z.string().uuid(),
    approvedById: z.string().uuid().nullable(),
    approvedByName: z.string(),
    approvedByEmail: z.string(),
    approvedAt: z.string().datetime(),
});

/** Why a recording is in the state it is in; derived from the audit row and its job, never stored. */
export const RECORDING_STATES = ['triage', 'queued', 'in_flight', 'recorded', 'failed', 'superseded'] as const;

export const SpecRecordingSchema = z.object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    jobStatus: z.enum(JOB_STATUSES),
    jobTitle: z.string(),
    prUrl: z.string().nullable(),
    state: z.enum(RECORDING_STATES),
    /** The job is merged on GitHub but its latest run reported blocked. */
    mergedWithoutWork: z.boolean(),
    dependsOnJobId: z.string().uuid().nullable(),
    /** Set once a newer recording replaced this one (a reused triage job or a cancelled queued one). */
    supersededByRecordingId: z.string().uuid().nullable(),
    supersededAt: z.string().datetime().nullable(),
    pinnedByFeatureId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
});

export const SpecEligibilitySchema = z.object({
    eligible: z.boolean(),
    reasons: z.array(z.string()),
});

export const SpecVersionResponseSchema = z.object({
    id: z.string().uuid(),
    version: z.number().int(),
    title: z.string(),
    /** Exactly the bytes that were saved. */
    body: z.string(),
    bodySha256: z.string(),
    criteria: z.array(SpecCriterionSchema),
    createdById: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    /** Whether this version could be approved now (open questions make it ineligible), with the reasons. */
    eligibility: SpecEligibilitySchema,
    approval: SpecApprovalEvidenceSchema.nullable(),
    recording: SpecRecordingSchema.nullable(),
});

export const SpecResponseSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    repoId: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    status: z.enum(SPEC_STATUSES),
    currentVersion: z.number().int(),
    approvedVersion: z.number().int().nullable(),
    createdById: z.string().uuid().nullable(),
    updatedById: z.string().uuid().nullable(),
    approvedById: z.string().uuid().nullable(),
    approvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export const SpecDetailResponseSchema = SpecResponseSchema.extend({
    /** Whether the calling user is a verified human who may approve (not whether the current version is eligible). */
    mayApprove: z.boolean(),
    mayApproveReasons: z.array(z.string()),
    /** Eligibility of the current version. */
    eligibility: SpecEligibilitySchema,
    /** Newest first. */
    versions: z.array(SpecVersionResponseSchema),
});

export type SpecResponseDto = z.infer<typeof SpecResponseSchema>;
export type SpecDetailResponseDto = z.infer<typeof SpecDetailResponseSchema>;
export type SpecVersionResponseDto = z.infer<typeof SpecVersionResponseSchema>;
export type SpecApprovalEvidenceDto = z.infer<typeof SpecApprovalEvidenceSchema>;
export type SpecRecordingDto = z.infer<typeof SpecRecordingSchema>;
export type SpecRecordingState = (typeof RECORDING_STATES)[number];
