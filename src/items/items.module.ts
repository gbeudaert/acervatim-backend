import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';

@Module({
  imports: [AuthModule], // pour JwtAuthGuard
  controllers: [ItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
