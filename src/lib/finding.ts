import { z } from 'zod';

/** Pass 1 output: one candidate finding per object. */
export const candidateSchema = z.object({
  file: z.string().min(1),
  line: z.coerce.number().int().min(1),
  title: z.string().min(4),
  evidenceQuote: z.string().min(1),
  why: z.string().min(4),
  suggestion: z.string().min(4),
  impact: z.coerce.number().int().min(0).max(10),
  certainty: z.coerce.number().int().min(0).max(10),
  blastRadius: z.coerce.number().int().min(0).max(10),
});
export type Candidate = z.infer<typeof candidateSchema>;

/** Pass 2 output: the same finding, judged against the real code. */
export const verifiedCandidateSchema = candidateSchema.extend({
  status: z.enum(['keep', 'drop', 'question']),
  verifiedEvidence: z.string().default(''),
});
export type VerifiedCandidate = z.infer<typeof verifiedCandidateSchema>;

export const candidateArraySchema = z.array(candidateSchema);
export const verifiedArraySchema = z.array(verifiedCandidateSchema);

export const gapCheckSchema = z.object({
  clean: z.boolean(),
  note: z.string().optional(),
});

export const consolidatorSchema = z.object({
  groups: z
    .array(
      z.object({
        ids: z.array(z.string()).min(1),
        comment: z.string().min(10),
      }),
    )
    .default([]),
});
export type ConsolidatorOutput = z.infer<typeof consolidatorSchema>;

/**
 * Teach-pass output: three sentences the harness renders into labeled parts.
 * The model never writes the comment and never sees a score — it explains, the
 * harness formats. `tryThis` is an optional paste-ready line.
 */
export const taughtFieldsSchema = z.object({
  what: z.string().trim().min(1),
  why: z.string().trim().min(1),
  how: z.string().trim().min(1),
  tryThis: z.string().trim().min(1).optional(),
});
export type TaughtFields = z.infer<typeof taughtFieldsSchema>;
