export interface PaginationQuery {
  limit?: number | string;
  skip?: number | string;
  cursor?: string;
}

export interface PaginationMeta {
  limit: number;
  skip?: number;
  nextCursor?: string | null;
  hasMore: boolean;
  totalCount?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export function parsePaginationParams(query?: PaginationQuery) {
  let limit = typeof query?.limit === 'string' ? parseInt(query.limit, 10) : query?.limit;
  let skip = typeof query?.skip === 'string' ? parseInt(query.skip, 10) : query?.skip;

  if (!limit || isNaN(limit) || limit <= 0) {
    limit = DEFAULT_PAGE_SIZE;
  } else {
    limit = Math.min(limit, MAX_PAGE_SIZE);
  }

  if (!skip || isNaN(skip) || skip < 0) {
    skip = 0;
  }

  const cursor = query?.cursor || undefined;

  return { limit, skip, cursor };
}

export function buildPaginatedResult<T>(
  items: T[],
  limit: number,
  getCursorFn?: (item: T) => string,
  totalCount?: number,
  skip?: number,
): PaginatedResult<T> {
  const safeLimit = Math.min(Math.max(limit || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  let nextCursor: string | null = null;
  let hasMore = false;

  if (items.length > safeLimit) {
    hasMore = true;
    const sliced = items.slice(0, safeLimit);
    if (getCursorFn && sliced.length > 0) {
      nextCursor = getCursorFn(sliced[sliced.length - 1]);
    }
    return {
      data: sliced,
      pagination: {
        limit: safeLimit,
        skip,
        nextCursor,
        hasMore,
        totalCount,
      },
    };
  }

  return {
    data: items,
    pagination: {
      limit: safeLimit,
      skip,
      nextCursor: null,
      hasMore: false,
      totalCount: totalCount ?? items.length,
    },
  };
}
