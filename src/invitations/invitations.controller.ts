import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminTokenGuard } from './admin-token.guard';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { RedeemInvitationDto } from './dto/redeem-invitation.dto';
import { InvitationsService } from './invitations.service';

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

  /**
   * Claim d'un code par l'utilisateur courant.
   * TODO(auth) : remplacer le header `x-user-id` par un AuthGuard JWT
   *              qui injecte `req.user.userId` une fois l'OAuth Google branché.
   */
  @Post('invitations/redeem')
  @HttpCode(HttpStatus.OK)
  async redeem(
    @Body() dto: RedeemInvitationDto,
    @Headers('x-user-id') userId?: string,
  ) {
    if (!userId || userId.length !== 36) {
      throw new BadRequestException('x-user-id header requis (UUID v4) — auth temporaire');
    }
    return this.invitations.redeem(dto.code, userId);
  }
}