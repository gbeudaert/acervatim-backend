import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcesModule } from '../common/sources/sources.module';
import { SharingModule } from '../sharing/sharing.module';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';

@Module({
  imports: [
    AuthModule, // pour JwtAuthGuard
    SourcesModule, // SourceSnapshotService
    SharingModule, // ShareFilterService : filtrage par statuts partages
  ],
  controllers: [ItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
