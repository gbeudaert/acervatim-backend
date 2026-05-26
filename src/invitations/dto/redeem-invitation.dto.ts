import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RedeemInvitationSchema = z.object({
  code: z.string().min(8).max(64),
});

export class RedeemInvitationDto extends createZodDto(RedeemInvitationSchema) {}
