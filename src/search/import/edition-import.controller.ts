import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateImportJobDto } from '../dto/create-import-job.dto';
import { EditionImportService } from './edition-import.service';
import { ApiJobState, EditionImportStatus } from './edition-import.types';

/**
 * Import de série **asynchrone** (fire-and-poll). L'app lance un job (`POST`), reçoit son id, poll
 * son statut (`GET`), puis — quand `done` — re-tape `GET /v1/search/edition-mapping` (cache chaud).
 * Ça sort le fan-out lent (BnF + ~30 jaquettes) du cycle requête-réponse : plus de timeout client
 * (cf. incident 0.5.3).
 */
@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
@UseGuards(JwtAuthGuard)
export class EditionImportController {
  constructor(private readonly editionImport: EditionImportService) {}

  /** Lance (ou réutilise) l'import d'une édition. `202 Accepted` + `{ jobId, state }`. */
  @Post('import-jobs')
  @HttpCode(202)
  async create(
    @Body() body: CreateImportJobDto,
  ): Promise<{ jobId: string; state: ApiJobState }> {
    return this.editionImport.enqueue(body.title, body.edition);
  }

  /** Statut + avancement d'un job. `404` si l'id est inconnu. */
  @Get('import-jobs/:id')
  async status(@Param('id') id: string): Promise<EditionImportStatus> {
    const status = await this.editionImport.status(id);
    if (!status) throw new NotFoundException('import job not found');
    return status;
  }
}
