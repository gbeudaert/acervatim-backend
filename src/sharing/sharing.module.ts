import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ShareFilterService } from './share-filter.service';
import { SharingController } from './sharing.controller';
import { SharingService } from './sharing.service';

@Module({
  imports: [AuthModule], // pour JwtAuthGuard
  controllers: [SharingController],
  providers: [SharingService, ShareFilterService],
  // `ShareFilterService` sort d'ici : c'est la sémantique des statuts partagés, elle appartient au
  // partage. `collections`/`items`/`nodes` l'importent pour filtrer leurs lectures.
  exports: [SharingService, ShareFilterService],
})
export class SharingModule {}
