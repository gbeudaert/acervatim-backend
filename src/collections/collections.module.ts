import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SharingModule } from '../sharing/sharing.module';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';

@Module({
  imports: [
    AuthModule, // pour JwtAuthGuard
    SharingModule, // ShareFilterService : filtrage par statuts partages
  ],
  controllers: [CollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
