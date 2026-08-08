import { AuthorizationPolicy, UserContext } from '@forgegate/auth';
import { WorkflowService } from '../src/workflow/workflow.service';
import { ExecutionService } from '../src/execution/execution.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

describe('Fine-Grained Authorization & Tenant Isolation', () => {
  // Test User Contexts
  const tenantA_Admin: UserContext = {
    id: 'user-admin-a',
    email: 'admin@tenant-a.com',
    role: 'admin',
    tenantId: 'tenant-a',
  };

  const tenantA_Owner1: UserContext = {
    id: 'user-owner-1',
    email: 'owner1@tenant-a.com',
    role: 'workflow_owner',
    tenantId: 'tenant-a',
  };

  const tenantA_Owner2: UserContext = {
    id: 'user-owner-2',
    email: 'owner2@tenant-a.com',
    role: 'workflow_owner',
    tenantId: 'tenant-a',
  };

  const tenantA_Operator: UserContext = {
    id: 'user-op-a',
    email: 'op@tenant-a.com',
    role: 'operator',
    tenantId: 'tenant-a',
  };

  const tenantA_Viewer: UserContext = {
    id: 'user-view-a',
    email: 'viewer@tenant-a.com',
    role: 'viewer',
    tenantId: 'tenant-a',
  };

  const tenantB_Admin: UserContext = {
    id: 'user-admin-b',
    email: 'admin@tenant-b.com',
    role: 'admin',
    tenantId: 'tenant-b',
  };

  describe('AuthorizationPolicy Engine Unit Tests', () => {
    it('should enforce strict tenant isolation across resources', () => {
      const resourceB = { tenantId: 'tenant-b', createdById: 'user-admin-b' };

      expect(AuthorizationPolicy.can(tenantA_Admin, 'workflow:read', resourceB)).toBe(false);
      expect(AuthorizationPolicy.can(tenantA_Admin, 'workflow:update', resourceB)).toBe(false);
      expect(AuthorizationPolicy.can(tenantA_Admin, 'workflow:execute', resourceB)).toBe(false);
    });

    it('should allow admin to manage all resources within tenant', () => {
      const resourceA = { tenantId: 'tenant-a', createdById: 'user-owner-1' };

      expect(AuthorizationPolicy.can(tenantA_Admin, 'workflow:create', resourceA)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Admin, 'workflow:read', resourceA)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Admin, 'workflow:update', resourceA)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Admin, 'workflow:delete', resourceA)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Admin, 'workflow:execute', resourceA)).toBe(true);
    });

    it('should restrict workflow_owner to modifying only their own workflows', () => {
      const ownWorkflow = { tenantId: 'tenant-a', createdById: 'user-owner-1' };
      const otherWorkflow = { tenantId: 'tenant-a', createdById: 'user-owner-2' };

      // Own workflow
      expect(AuthorizationPolicy.can(tenantA_Owner1, 'workflow:update', ownWorkflow)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Owner1, 'workflow:delete', ownWorkflow)).toBe(true);

      // Other user's workflow
      expect(AuthorizationPolicy.can(tenantA_Owner1, 'workflow:update', otherWorkflow)).toBe(false);
      expect(AuthorizationPolicy.can(tenantA_Owner1, 'workflow:delete', otherWorkflow)).toBe(false);
      // But can read and execute other user's workflow in same tenant
      expect(AuthorizationPolicy.can(tenantA_Owner1, 'workflow:read', otherWorkflow)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Owner1, 'workflow:execute', otherWorkflow)).toBe(true);
    });

    it('should allow operators to view and execute, but not modify or create workflows', () => {
      const workflow = { tenantId: 'tenant-a', createdById: 'user-owner-1' };

      expect(AuthorizationPolicy.can(tenantA_Operator, 'workflow:read', workflow)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Operator, 'workflow:execute', workflow)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Operator, 'workflow:create', workflow)).toBe(false);
      expect(AuthorizationPolicy.can(tenantA_Operator, 'workflow:update', workflow)).toBe(false);
      expect(AuthorizationPolicy.can(tenantA_Operator, 'workflow:delete', workflow)).toBe(false);
    });

    it('should restrict viewers to read-only access', () => {
      const workflow = { tenantId: 'tenant-a', createdById: 'user-owner-1' };

      expect(AuthorizationPolicy.can(tenantA_Viewer, 'workflow:read', workflow)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Viewer, 'execution:read', workflow)).toBe(true);
      expect(AuthorizationPolicy.can(tenantA_Viewer, 'workflow:execute', workflow)).toBe(false);
      expect(AuthorizationPolicy.can(tenantA_Viewer, 'workflow:create', workflow)).toBe(false);
      expect(AuthorizationPolicy.can(tenantA_Viewer, 'workflow:update', workflow)).toBe(false);
      expect(AuthorizationPolicy.can(tenantA_Viewer, 'workflow:delete', workflow)).toBe(false);
    });
  });

  describe('WorkflowService & ExecutionService Integration Guards', () => {
    let mockPrisma: any;
    let mockQueueService: any;
    let workflowService: WorkflowService;
    let executionService: ExecutionService;

    beforeEach(() => {
      mockPrisma = {
        workflow: {
          create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'wf-new', ...args.data })),
          findMany: jest.fn().mockResolvedValue([
            { id: 'wf-1', tenantId: 'tenant-a', createdById: 'user-owner-1' },
          ]),
          findFirst: jest.fn().mockImplementation((args) => {
            const { id, tenantId } = args.where;
            if (id === 'wf-1' && tenantId === 'tenant-a') {
              return Promise.resolve({ id: 'wf-1', tenantId: 'tenant-a', createdById: 'user-owner-1', name: 'Wf 1' });
            }
            if (id === 'wf-b' && tenantId === 'tenant-b') {
              return Promise.resolve({ id: 'wf-b', tenantId: 'tenant-b', createdById: 'user-admin-b', name: 'Wf B' });
            }
            return Promise.resolve(null);
          }),
          update: jest.fn().mockImplementation((args) => Promise.resolve({ id: args.where.id, ...args.data })),
          delete: jest.fn().mockResolvedValue({ id: 'wf-1' }),
        },
        workflowExecution: {
          create: jest.fn().mockResolvedValue({ id: 'exec-100', status: 'pending' }),
          findUnique: jest.fn().mockImplementation((args) => {
            if (args.where.id === 'exec-a') {
              return Promise.resolve({ id: 'exec-a', tenantId: 'tenant-a', status: 'completed' });
            }
            if (args.where.id === 'exec-b') {
              return Promise.resolve({ id: 'exec-b', tenantId: 'tenant-b', status: 'completed' });
            }
            return Promise.resolve(null);
          }),
        },
      };

      mockQueueService = {
        addExecutionJob: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
      };

      workflowService = new WorkflowService(mockPrisma as any);
      executionService = new ExecutionService(mockPrisma as any, mockQueueService as any);
    });

    it('should ignore client-supplied tenantId and enforce JWT user tenantId on workflow creation', async () => {
      const dto = {
        name: 'Forced Tenant Test',
        tenantId: 'tenant-malicious-bypass', // Attempted forgery
        createdById: 'user-spoofed',
      };

      const result = await workflowService.createWorkflow(dto as any, tenantA_Admin);

      expect(result.tenantId).toBe('tenant-a');
      expect(result.createdById).toBe('user-admin-a');
    });

    it('should block viewers from creating workflows', async () => {
      const dto = { name: 'Unauthorized Creation' };
      await expect(workflowService.createWorkflow(dto as any, tenantA_Viewer)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should prevent Tenant A user from accessing Tenant B workflow (404/Forbidden)', async () => {
      await expect(workflowService.getWorkflowById('wf-b', tenantA_Admin)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should prevent non-owner workflow_owner from deleting another user workflow', async () => {
      await expect(workflowService.deleteWorkflow('wf-1', tenantA_Owner2)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow admin to delete any workflow within tenant', async () => {
      const res = await workflowService.deleteWorkflow('wf-1', tenantA_Admin);
      expect(res).toEqual({ status: 'deleted', id: 'wf-1' });
    });

    it('should block viewers from triggering workflow execution', async () => {
      await expect(executionService.triggerWorkflow('wf-1', {}, tenantA_Viewer)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow operator to trigger workflow execution in own tenant', async () => {
      const res = await executionService.triggerWorkflow('wf-1', {}, tenantA_Operator);
      expect(res.executionId).toBe('exec-100');
    });

    it('should prevent Tenant A user from fetching Tenant B execution logs', async () => {
      await expect(executionService.getExecution('exec-b', tenantA_Admin)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
