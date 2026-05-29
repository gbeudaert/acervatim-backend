import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { filterIn } from '../../common/filters/parse-filters';
import { PaginationQuerySchema } from '../../common/pagination/paginate';
import { ITEM_SOURCE_CODES } from '../item-source-codes';

export const ListItemsQuerySchema = PaginationQuerySchema.extend({
  // Items dont sources[] contient au moins un des providers listés (OR).
  provider: filterIn(ITEM_SOURCE_CODES).optional(),
  // Drill-down : tomes d'une série (types hiérarchiques uniquement ; plat → 400).
  nodeId: z.string().uuid().optional(),
}).strict();

export class ListItemsQueryDto extends createZodDto(ListItemsQuerySchema) {}
