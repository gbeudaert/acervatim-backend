import { createZodDto } from 'nestjs-zod';
import { filterIn } from '../../common/filters/parse-filters';
import { PaginationQuerySchema } from '../../common/pagination/paginate';
import { COLLECTION_TYPE_CODES } from '../collection-type-codes';

export const ListCollectionsQuerySchema = PaginationQuerySchema.extend({
  type: filterIn(COLLECTION_TYPE_CODES).optional(),
}).strict();

export class ListCollectionsQueryDto extends createZodDto(
  ListCollectionsQuerySchema,
) {}
