import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { QuotaService } from '../common/quota/quota.service';
import { PremiumService } from '../premium/premium.service';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly quota: QuotaService,
    private readonly premium: PremiumService,
  ) {}

  @Get()
  async me(@CurrentUserId() userId: string) {
    const [me, premium] = await Promise.all([
      this.users.findById(userId),
      this.premium.getStatus(userId),
    ]);
    return { ...me, premium };
  }

  @Get('quota')
  async getQuota(@CurrentUserId() userId: string) {
    return this.quota.getQuotaSummary(userId);
  }

  @Get('export')
  async export(@CurrentUserId() userId: string, @Res() res: Response) {
    const payload = await this.users.exportMe(userId);
    const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `acervatim-export-${userId}-${yyyymmdd}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(HttpStatus.OK).send(JSON.stringify(payload, jsonReplacer));
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  async delete(@CurrentUserId() userId: string) {
    return this.users.deleteMe(userId);
  }
}

/** Prisma renvoie des BigInt pour certains champs (subscription.expiresAt, etc.). */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
