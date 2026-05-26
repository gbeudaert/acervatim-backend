import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminTokenGuard } from './admin-token.guard';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { RedeemInvitationDto } from './dto/redeem-invitation.dto';
import { InvitationsService } from './invitations.service';

@ApiTags('invitations')
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /**
   * Création d'invitation — admin uniquement.
   * Le `code` retourné n'est affiché qu'ici, jamais re-récupérable.
   */
  @Post('admin/invitations')
  @UseGuards(AdminTokenGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateInvitationDto) {
    const { code, codeHash } = await this.invitations.create(dto);
    return { code, codeHash };
  }

  /** Claim d'un code par l'utilisateur courant (JWT). */
  @Post('invitations/redeem')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  async redeem(
    @Body() dto: RedeemInvitationDto,
    @CurrentUserId() userId: string,
  ) {
    return this.invitations.redeem(dto.code, userId);
  }
}
