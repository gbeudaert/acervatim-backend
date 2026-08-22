import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SharingController } from './sharing.controller';
import { SharingService } from './sharing.service';

@Module({
  imports: [AuthModule], // pour JwtAuthGuard
  controllers: [SharingController],
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
