import { createZodDto } from 'nestjs-zod';
import { filterIn } from '../../common/filters/parse-filters';
import { PaginationQuerySchema } from '../../common/pagination/paginate';
import { ITEM_SOURCE_CODES } from '../item-source-codes';

export const ListItemsQuerySchema = PaginationQuerySchema.extend({
  source: filterIn(ITEM_SOURCE_CODES).optional(),
}).strict();

export class ListItemsQueryDto extends createZodDto(ListItemsQuerySchema) {}
