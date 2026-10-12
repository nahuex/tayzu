/**
 * Organization access control (task 9.1b, design D8, Resolved decisions Q29
 * and Q94). Custom roles replace Better Auth's defaults, so all three roles
 * are built from the default statements and keep every default permission.
 * `admin` and `owner` additionally hold `apiKey` create/read/update/delete:
 * the grant is read only by Better Auth's own organization-permission check,
 * which runs with `body.userId` on the headerless key calls. Cerbos is the
 * real gate; the grant only keeps Better Auth from refusing what Cerbos
 * allowed (ADR-0013 records that it is otherwise neutralized).
 */
import { createAccessControl } from 'better-auth/plugins/access';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';

const API_KEY_ACTIONS = ['create', 'read', 'update', 'delete'] as const;

const ac = createAccessControl({ ...defaultStatements, apiKey: API_KEY_ACTIONS });

export const organizationAccess = {
  ac,
  roles: {
    owner: ac.newRole({ ...ownerAc.statements, apiKey: [...API_KEY_ACTIONS] }),
    admin: ac.newRole({ ...adminAc.statements, apiKey: [...API_KEY_ACTIONS] }),
    member: ac.newRole({ ...memberAc.statements }),
  },
};
