import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';

@Injectable()
export class HashService {
  hmacSha256Hex(secret: string, value: string): string {
    return createHmac('sha256', secret).update(value).digest('hex');
  }
}
