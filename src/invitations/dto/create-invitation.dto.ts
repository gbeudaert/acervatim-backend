import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const INVITATION_REASONS = ['beta_tester', 'comp', 'support', 'admin'] as const;
export type InvitationReason = (typeof INVITATION_REASONS)[number];

export const CreateInvitationSchema = z.object({
  reason: z.enum(INVITATION_REASONS),
  grantsPremium: z.boolean().optional(),
  /** epoch ms ; null/absent = premium permanent (si grantsPremium). */
  premiumExpiresAt: z.number().int().min(0).nullable().optional(),
  maxUses: z.number().int().min(1).max(10_000).optional(),
  /** epoch ms ; null/absent = ne périme jamais. */
  expiresAt: z.number().int().min(0).nullable().optional(),
  createdBy: z.string().max(64).optional(),
  notes: z.string().max(1000).optional(),
});

export class CreateInvitationDto extends createZodDto(CreateInvitationSchema) {}
