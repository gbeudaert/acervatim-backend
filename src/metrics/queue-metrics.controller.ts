import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminTokenGuard } from '../invitations/admin-token.guard';
import { QueueMetricsService } from './queue-metrics.service';

/**
 * Endpoint d'observabilité des files BullMQ, réservé à l'admin (Bearer `ADMIN_API_TOKEN`). Sert un
 * instantané des compteurs (backlog / débit récent / échecs) pour surveiller la passerelle sortante
 * et calibrer les limiters — cf. {@link QueueMetricsService}.
 */
@Controller('admin')
export class QueueMetricsController {
  constructor(private readonly metrics: QueueMetricsService) {}

  @Get('queues')
  @UseGuards(AdminTokenGuard)
  @SkipThrottle()
  async queues() {
    return { queues: await this.metrics.snapshot() };
  }
}
