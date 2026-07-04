import { Global, Module } from '@nestjs/common';
import { GoogleBooksCoverService } from './googlebooks.service';

/**
 * Global (comme `BnfModule`) : `GoogleBooksCoverService` est injectable partout — notamment
 * dans `SearchService` pour enrichir l'énumération d'édition en jaquettes par ISBN.
 */
@Global()
@Module({
  providers: [GoogleBooksCoverService],
  exports: [GoogleBooksCoverService],
})
export class GoogleBooksModule {}
