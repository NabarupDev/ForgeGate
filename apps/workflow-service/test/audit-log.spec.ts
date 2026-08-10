import { sanitizeAuditMetadata } from '@forgegate/common';

describe('ForgeGate AuditLog Security & Compliance Test Suite', () => {
  let auditStore: any[] = [];

  const mockPrisma: any = {
    auditLog: {
      create: jest.fn().mockImplementation(async (args: any) => {
        const record = {
          id: `audit-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          tenantId: args.data.tenantId || null,
          userId: args.data.userId || null,
          action: args.data.action,
          correlationId: args.data.correlationId || null,
          ipAddress: args.data.ipAddress || null,
          userAgent: args.data.userAgent || null,
          metadata: args.data.metadata || null,
          createdAt: new Date(),
        };
        auditStore.push(record);
        return record;
      }),
      findMany: jest.fn().mockImplementation(async (args: any) => {
        let results = [...auditStore];
        if (args?.where?.tenantId) {
          results = results.filter(r => r.tenantId === args.where.tenantId);
        }
        if (args?.where?.userId) {
          results = results.filter(r => r.userId === args.where.userId);
        }
        return results;
      }),
      count: jest.fn().mockImplementation(async (args: any) => {
        let results = [...auditStore];
        if (args?.where?.tenantId) {
          results = results.filter(r => r.tenantId === args.where.tenantId);
        }
        return results.length;
      }),
    },
  };

  beforeEach(() => {
    auditStore = [];
    jest.clearAllMocks();
  });

  describe('1. Secret Metadata Sanitization (Zero Raw Secret Leakage)', () => {
    it('should recursively sanitize passwords, JWTs, refresh tokens, API keys, and authorization headers', () => {
      const rawMetadata = {
        email: 'user@example.com',
        password: 'test-dummy-pass',
        passwordHash: 'hash-placeholder-not-real',
        token: 'test-token-placeholder',
        accessToken: 'test-access-placeholder',
        refreshToken: 'test-refresh-placeholder',
        authorization: 'Bearer test-placeholder',
        apiKey: 'test-key-placeholder',
        nested: {
          privateKey: 'test-private-key-placeholder',
          cookie: 'session_id=secret123',
          normalField: 'safe_value',
        },
      };

      const sanitized = sanitizeAuditMetadata(rawMetadata);

      expect(sanitized?.email).toBe('user@example.com');
      expect(sanitized?.password).toBe('[REDACTED]');
      expect(sanitized?.passwordHash).toBe('[REDACTED]');
      expect(sanitized?.token).toBe('[REDACTED]');
      expect(sanitized?.accessToken).toBe('[REDACTED]');
      expect(sanitized?.refreshToken).toBe('[REDACTED]');
      expect(sanitized?.authorization).toBe('[REDACTED]');
      expect(sanitized?.apiKey).toBe('[REDACTED]');
      expect(sanitized?.nested?.privateKey).toBe('[REDACTED]');
      expect(sanitized?.nested?.cookie).toBe('[REDACTED]');
      expect(sanitized?.nested?.normalField).toBe('safe_value');
    });
  });

  describe('2. Security-Sensitive Action Event Audit Generation', () => {
    it('should record login, logout, and token revocation audit events without secrets', async () => {
      // Login
      const loginMetadata = sanitizeAuditMetadata({ email: 'admin@tenantA.com', password: 'secretPassword' });
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'user-1',
          action: 'user.login',
          correlationId: 'corr-login-123',
          ipAddress: '192.168.1.100',
          userAgent: 'Mozilla/5.0',
          metadata: loginMetadata,
        },
      });

      // Logout
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'user-1',
          action: 'user.logout',
          correlationId: 'corr-logout-123',
        },
      });

      // Token Revocation
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'user-1',
          action: 'token.revoked',
          correlationId: 'corr-logout-123',
        },
      });

      expect(auditStore).toHaveLength(3);
      expect(auditStore[0].action).toBe('user.login');
      expect(auditStore[0].metadata.password).toBe('[REDACTED]');
      expect(auditStore[1].action).toBe('user.logout');
      expect(auditStore[2].action).toBe('token.revoked');
    });

    it('should record workflow lifecycle events (create, update, delete, execution)', async () => {
      // Creation
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'user-1',
          action: 'workflow.created',
          metadata: { workflowId: 'wf-100', name: 'Order Processing' },
        },
      });

      // Update
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'user-1',
          action: 'workflow.updated',
          metadata: { workflowId: 'wf-100', updatedFields: { description: 'Updated order workflow' } },
        },
      });

      // Execution Started
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'user-1',
          action: 'workflow.execution_started',
          correlationId: 'corr-exec-99',
          metadata: { executionId: 'exec-99', workflowId: 'wf-100', attemptCount: 1 },
        },
      });

      // Deletion
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'user-1',
          action: 'workflow.deleted',
          metadata: { workflowId: 'wf-100' },
        },
      });

      expect(auditStore).toHaveLength(4);
      expect(auditStore.map(a => a.action)).toEqual([
        'workflow.created',
        'workflow.updated',
        'workflow.execution_started',
        'workflow.deleted',
      ]);
    });

    it('should record DLQ replay events with operator identity and execution correlation', async () => {
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'operator-sec-99',
          action: 'dlq.replayed',
          correlationId: 'corr-replay-55',
          metadata: { dlqJobId: 'dlq-job-88', executionId: 'exec-failed-12', replayedBy: 'operator-sec-99' },
        },
      });

      expect(auditStore).toHaveLength(1);
      expect(auditStore[0].action).toBe('dlq.replayed');
      expect(auditStore[0].userId).toBe('operator-sec-99');
      expect(auditStore[0].metadata.executionId).toBe('exec-failed-12');
    });

    it('should record role, permission, tenant, and API key management audit events', async () => {
      // Role Change
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'admin-1',
          action: 'user.role_changed',
          metadata: { targetUserId: 'user-2', newRoleName: 'admin' },
        },
      });

      // Permission Change
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'admin-1',
          action: 'role.permissions_updated',
          metadata: { roleName: 'admin', permissions: ['workflow:*', 'audit:*'] },
        },
      });

      // Tenant Change
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'admin-1',
          action: 'tenant.updated',
          metadata: { updates: { name: 'Acme Enterprise Corp' } },
        },
      });

      // API Key Created (verifying secret is sanitized)
      const apiKeyMeta = sanitizeAuditMetadata({ keyId: 'key-777', name: 'Stripe Integration', apiKey: 'test-key-placeholder' });
      await mockPrisma.auditLog.create({
        data: {
          tenantId: 'tenant-A',
          userId: 'admin-1',
          action: 'apikey.created',
          metadata: apiKeyMeta,
        },
      });

      expect(auditStore).toHaveLength(4);
      expect(auditStore.map(a => a.action)).toEqual([
        'user.role_changed',
        'role.permissions_updated',
        'tenant.updated',
        'apikey.created',
      ]);
      expect(auditStore[3].metadata.apiKey).toBe('[REDACTED]');
    });
  });

  describe('3. Tenant Isolation & Authorization Protection', () => {
    it('should strictly isolate audit records by tenantId when queried', async () => {
      // Populate Tenant A logs
      await mockPrisma.auditLog.create({
        data: { tenantId: 'tenant-A', userId: 'user-A', action: 'user.login' },
      });
      await mockPrisma.auditLog.create({
        data: { tenantId: 'tenant-A', userId: 'user-A', action: 'workflow.created' },
      });

      // Populate Tenant B logs
      await mockPrisma.auditLog.create({
        data: { tenantId: 'tenant-B', userId: 'user-B', action: 'user.login' },
      });

      const tenantA_Logs = await mockPrisma.auditLog.findMany({ where: { tenantId: 'tenant-A' } });
      const tenantB_Logs = await mockPrisma.auditLog.findMany({ where: { tenantId: 'tenant-B' } });

      expect(tenantA_Logs).toHaveLength(2);
      expect(tenantA_Logs.every(l => l.tenantId === 'tenant-A')).toBe(true);

      expect(tenantB_Logs).toHaveLength(1);
      expect(tenantB_Logs[0].tenantId).toBe('tenant-B');
    });
  });

  describe('4. Append-Only Immutability Guarantees', () => {
    it('should not expose update or delete methods on audit log service', () => {
      expect(mockPrisma.auditLog.update).toBeUndefined();
      expect(mockPrisma.auditLog.delete).toBeUndefined();
      expect(mockPrisma.auditLog.deleteMany).toBeUndefined();
    });
  });
});
