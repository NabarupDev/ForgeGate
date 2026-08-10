import { parsePaginationParams, buildPaginatedResult, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@forgegate/common';

describe('Collection Pagination & Query Safety Spec', () => {
  describe('1. Pagination Parameter Parsing', () => {
    it('should apply default page size (50) when limit is missing or invalid', () => {
      const params1 = parsePaginationParams();
      expect(params1.limit).toBe(DEFAULT_PAGE_SIZE);
      expect(params1.skip).toBe(0);

      const params2 = parsePaginationParams({ limit: -10, skip: -5 });
      expect(params2.limit).toBe(DEFAULT_PAGE_SIZE);
      expect(params2.skip).toBe(0);
    });

    it('should enforce MAX_PAGE_SIZE (100) safety cap when requested limit exceeds maximum', () => {
      const params = parsePaginationParams({ limit: 500 });
      expect(params.limit).toBe(MAX_PAGE_SIZE);
    });

    it('should parse valid limit, skip, and cursor parameters', () => {
      const params = parsePaginationParams({ limit: '25', skip: '50', cursor: 'cursor-abc' });
      expect(params.limit).toBe(25);
      expect(params.skip).toBe(50);
      expect(params.cursor).toBe('cursor-abc');
    });
  });

  describe('2. Response Envelope & Next Cursor Generation', () => {
    it('should construct paginated response when items count fits within limit', () => {
      const items = [{ id: 'wf-1' }, { id: 'wf-2' }];
      const result = buildPaginatedResult(items, 10, (item) => item.id, 2);

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({
        limit: 10,
        skip: undefined,
        nextCursor: null,
        hasMore: false,
        totalCount: 2,
      });
    });

    it('should slice data to safe limit and calculate nextCursor when items count > limit', () => {
      const items = [{ id: 'wf-1' }, { id: 'wf-2' }, { id: 'wf-3' }];
      const result = buildPaginatedResult(items, 2, (item) => item.id, 10);

      expect(result.data).toHaveLength(2);
      expect(result.data.map((x) => x.id)).toEqual(['wf-1', 'wf-2']);
      expect(result.pagination).toEqual({
        limit: 2,
        skip: undefined,
        nextCursor: 'wf-2',
        hasMore: true,
        totalCount: 10,
      });
    });
  });

  describe('3. Service Collection Endpoints Pagination Integration', () => {
    it('should fetch workflows with tenant scope, total count and paginated envelope', async () => {
      const mockPrisma: any = {
        workflow: {
          count: jest.fn().mockResolvedValue(15),
          findMany: jest.fn().mockResolvedValue([
            { id: 'wf-1', tenantId: 'tenant-a', name: 'Workflow 1' },
            { id: 'wf-2', tenantId: 'tenant-a', name: 'Workflow 2' },
            { id: 'wf-3', tenantId: 'tenant-a', name: 'Workflow 3' },
          ]),
        },
      };

      const { WorkflowService } = await import('../src/workflow/workflow.service');
      const service = new WorkflowService(mockPrisma);

      const userCtx = { id: 'user-1', email: 'admin@forgegate.com', role: 'admin', tenantId: 'tenant-a' };
      const res = await service.getWorkflows(userCtx, { limit: 2 });

      expect(mockPrisma.workflow.count).toHaveBeenCalledWith({ where: { tenantId: 'tenant-a' } });
      expect(mockPrisma.workflow.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId: 'tenant-a' },
        take: 3,
      }));
      expect(res.data).toHaveLength(2);
      expect(res.pagination.nextCursor).toBe('wf-2');
      expect(res.pagination.hasMore).toBe(true);
      expect(res.pagination.totalCount).toBe(15);
    });

    it('should fetch executions with tenant scope and filter options', async () => {
      const mockPrisma: any = {
        workflowExecution: {
          count: jest.fn().mockResolvedValue(1),
          findMany: jest.fn().mockResolvedValue([
            { id: 'exec-1', tenantId: 'tenant-b', status: 'completed' },
          ]),
        },
      };

      const { ExecutionService } = await import('../src/execution/execution.service');
      const service = new ExecutionService(mockPrisma, {} as any);

      const userCtx = { id: 'user-1', email: 'admin@forgegate.com', role: 'admin', tenantId: 'tenant-b' };
      const res = await service.getExecutions(userCtx, { status: 'completed' }, { limit: 10 });

      expect(mockPrisma.workflowExecution.count).toHaveBeenCalledWith({ where: { tenantId: 'tenant-b', status: 'completed' } });
      expect(res.data).toHaveLength(1);
      expect(res.pagination.totalCount).toBe(1);
    });
  });
});
