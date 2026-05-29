import { createZodDto } from 'nestjs-zod';
import { filterIn, searchFilter } from '../../common/filters/parse-filters';
import { PaginationQuerySchema } from '../../common/pagination/paginate';
import { COLLECTION_TYPE_CODES } from '../collection-type-codes';

export const ListCollectionsQuerySchema = PaginationQuerySchema.extend({
  type: filterIn(COLLECTION_TYPE_CODES).optional(),
  // Recherche substring sur le contenu des items (title/name/artist/author) :
  // items[in]=a,b (OR) et items[all]=a,b (AND). Cf. CollectionsService.list.
  items: searchFilter().optional(),
}).strict();

export class ListCollectionsQueryDto extends createZodDto(
  ListCollectionsQuerySchema,
) {}
