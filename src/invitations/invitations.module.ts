import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminTokenGuard } from './admin-token.guard';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [AuthModule], // pour JwtAuthGuard
  controllers: [InvitationsController],
  providers: [InvitationsService, AdminTokenGuard],
  exports: [InvitationsService],
})
export class InvitationsModule {}
