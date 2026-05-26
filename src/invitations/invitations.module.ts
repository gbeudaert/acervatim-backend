import { Module } from '@nestjs/common';
import { AdminTokenGuard } from './admin-token.guard';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  controllers: [InvitationsController],
  providers: [InvitationsService, AdminTokenGuard],
  exports: [InvitationsService],
})
export class InvitationsModule {}