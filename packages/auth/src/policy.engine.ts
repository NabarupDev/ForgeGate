import { UserContext } from './interfaces/jwt-payload.interface';

export type AuthorizationAction =
  | 'workflow:create'
  | 'workflow:read'
  | 'workflow:update'
  | 'workflow:delete'
  | 'workflow:execute'
  | 'execution:read';

export interface ResourceSubject {
  tenantId?: string;
  createdById?: string;
  [key: string]: any;
}

export class AuthorizationPolicy {
  /**
   * Evaluates if a given user context is authorized to perform an action on a resource subject.
   */
  static can(user: UserContext, action: AuthorizationAction, resource?: ResourceSubject): boolean {
    if (!user || !user.role || !user.tenantId) {
      return false;
    }

    // 1. Strict Tenant Isolation Check
    if (resource && resource.tenantId && resource.tenantId !== user.tenantId) {
      return false;
    }

    const role = user.role.toLowerCase();

    // 2. Admin role: Manage everything within user's tenant
    if (role === 'admin') {
      return true;
    }

    // 3. Viewer role: Read-only access within tenant
    if (role === 'viewer') {
      return action === 'workflow:read' || action === 'execution:read';
    }

    // 4. Operator role: View and execute workflows within tenant
    if (role === 'operator') {
      return (
        action === 'workflow:read' ||
        action === 'execution:read' ||
        action === 'workflow:execute'
      );
    }

    // 5. Workflow Owner / Standard User role
    if (role === 'workflow_owner' || role === 'user' || role === 'moderator') {
      if (action === 'workflow:create' || action === 'workflow:read' || action === 'execution:read' || action === 'workflow:execute') {
        return true;
      }

      if (action === 'workflow:update' || action === 'workflow:delete') {
        // Must own the workflow or resource
        if (!resource || !resource.createdById) {
          return true;
        }
        return resource.createdById === user.id;
      }
    }

    return false;
  }
}
