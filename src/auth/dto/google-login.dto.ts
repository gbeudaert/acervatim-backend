import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const GoogleLoginSchema = z.object({
  idToken: z.string().min(1),
});

export class GoogleLoginDto extends createZodDto(GoogleLoginSchema) {}
