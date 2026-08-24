import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcesModule } from '../common/sources/sources.module';
import { SharingModule } from '../sharing/sharing.module';
import { NodesController } from './nodes.controller';
import { NodesService } from './nodes.service';

@Module({
  imports: [
    AuthModule, // pour JwtAuthGuard
    SourcesModule, // SourceSnapshotService
    SharingModule, // ShareFilterService : filtrage par statuts partages
  ],
  controllers: [NodesController],
  providers: [NodesService],
  exports: [NodesService],
})
export class NodesModule {}
