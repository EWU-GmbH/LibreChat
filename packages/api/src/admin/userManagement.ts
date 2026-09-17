import { Types } from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import { isValidObjectIdString, logger } from '@librechat/data-schemas';
import type {
  AdminInviteUserRequest,
  AdminUser,
  AdminUsersPage,
  UserMCPAccess,
} from 'librechat-data-provider';
import type {
  IUser,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
  TokenCreateData,
  TokenDeleteResult,
} from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createInvite } from '~/auth/invite';
import { buildAuditContext } from './context';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 200;
const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 30;
const USER_FIELDS =
  '_id name username email role provider blocked lastLoginAt createdAt mcpAccess tenantId';

interface InviteBody extends Partial<AdminInviteUserRequest> {
  email?: string;
}

interface StatusBody {
  blocked?: boolean;
}

interface MCPAccessBody {
  mcpAccess?: UserMCPAccess;
}

interface EmailOptions {
  email: string;
  subject: string;
  payload: {
    appName: string;
    inviteLink: string;
    year: number;
  };
  template: 'inviteUser.handlebars';
}

export interface AdminUserManagementDeps {
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ) => Promise<IUser[]>;
  countUsers: (filter?: FilterQuery<IUser>) => Promise<number>;
  updateUser: (userId: string, updateData: Partial<IUser>) => Promise<IUser | null>;
  deleteAllUserSessions: (userId: string) => Promise<{ deletedCount?: number }>;
  createToken: (data: TokenCreateData) => Promise<object>;
  deleteTokens: (query: {
    email?: string | null;
    type?: string | null;
  }) => Promise<TokenDeleteResult>;
  sendEmail: (options: EmailOptions) => Promise<void>;
  checkEmailConfig: () => boolean;
  resolveMCPServerNames: (req: ServerRequest) => Promise<string[]>;
  recordAuditEntry?: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<object | null>;
}

function parseLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function decodeCursor(value: string | undefined): Types.ObjectId | null {
  if (!value) {
    return null;
  }
  try {
    const id = Buffer.from(value, 'base64url').toString('utf8');
    return isValidObjectIdString(id) ? new Types.ObjectId(id) : null;
  } catch {
    return null;
  }
}

function encodeCursor(id: Types.ObjectId): string {
  return Buffer.from(id.toString()).toString('base64url');
}

function normalizeMCPAccess(access: UserMCPAccess | undefined): UserMCPAccess {
  if (!access || access.policy === 'all') {
    return { policy: 'all', servers: [] };
  }
  return { policy: 'allowlist', servers: [...new Set(access.servers)].sort() };
}

function validateMCPAccess(
  access: UserMCPAccess | undefined,
  available: Set<string>,
): string | null {
  if (!access || !['all', 'allowlist'].includes(access.policy) || !Array.isArray(access.servers)) {
    return 'Invalid MCP access policy';
  }
  if (access.policy === 'all' && access.servers.length > 0) {
    return 'The all policy cannot include server names';
  }
  const invalid = access.servers.find(
    (server) => typeof server !== 'string' || !available.has(server),
  );
  return invalid ? `Unknown MCP server: ${invalid}` : null;
}

function mapUser(user: IUser): AdminUser {
  return {
    id: user._id.toString(),
    name: user.name ?? '',
    username: user.username ?? '',
    email: user.email,
    role: user.role ?? SystemRoles.USER,
    provider: user.provider,
    blocked: user.blocked === true,
    lastLoginAt: user.lastLoginAt?.toISOString(),
    createdAt: user.createdAt?.toISOString(),
    mcpAccess: normalizeMCPAccess(user.mcpAccess),
  };
}

function resolveCaller(req: ServerRequest): {
  id: string;
  name: string;
  tenantId?: string;
} | null {
  const user = req.user;
  const id = user?._id?.toString() ?? user?.id;
  if (!user || !id) {
    return null;
  }
  return {
    id,
    name: user.name || user.username || user.email || id,
    tenantId: user.tenantId,
  };
}

export function createAdminUserManagementHandlers(deps: AdminUserManagementDeps): {
  listUsers: (req: ServerRequest, res: Response) => Promise<Response>;
  listMCPServers: (req: ServerRequest, res: Response) => Promise<Response>;
  inviteUser: (req: ServerRequest, res: Response) => Promise<Response>;
  revokeInvite: (req: ServerRequest, res: Response) => Promise<Response>;
  updateStatus: (req: ServerRequest, res: Response) => Promise<Response>;
  updateMCPAccess: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  async function audit(
    req: ServerRequest,
    action: RecordAuditEntryInput['action'],
    target: { id?: string; name?: string },
    metadata?: RecordAuditEntryInput['metadata'],
  ): Promise<void> {
    const caller = resolveCaller(req);
    if (!caller || !deps.recordAuditEntry) {
      return;
    }
    try {
      await deps.recordAuditEntry({
        action,
        outcome: 'success',
        severity: 'warning',
        actor: { type: 'user', id: caller.id, name: caller.name },
        target: { type: 'user', ...target },
        metadata,
        context: buildAuditContext(req),
        tenantId: caller.tenantId,
      });
    } catch (error) {
      logger.error('[adminUserManagement] audit write failed', error);
    }
  }

  async function listUsers(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const limit = parseLimit(typeof req.query.limit === 'string' ? req.query.limit : undefined);
      const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      if (rawSearch.length > MAX_SEARCH_LENGTH) {
        return res.status(400).json({ error: 'Search must not exceed 200 characters' });
      }
      const cursorValue = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const cursor = decodeCursor(cursorValue);
      if (cursorValue && !cursor) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }

      const filter: FilterQuery<IUser> = {};
      if (cursor) {
        filter._id = { $lt: cursor };
      }
      if (rawSearch) {
        const escaped = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        filter.$or = [{ email: regex }, { name: regex }, { username: regex }];
      }

      const users = await deps.findUsers(filter, USER_FIELDS, {
        limit: limit + 1,
        sort: { _id: -1 },
      });
      const hasNextPage = users.length > limit;
      const pageUsers = hasNextPage ? users.slice(0, limit) : users;
      const page: AdminUsersPage = {
        users: pageUsers.map(mapUser),
        nextCursor:
          hasNextPage && pageUsers.length > 0
            ? encodeCursor(pageUsers[pageUsers.length - 1]._id)
            : undefined,
      };
      return res.status(200).json(page);
    } catch (error) {
      logger.error('[adminUserManagement] list users failed', error);
      return res.status(500).json({ error: 'Failed to list users' });
    }
  }

  async function listMCPServers(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const servers = [...new Set(await deps.resolveMCPServerNames(req))].sort();
      return res.status(200).json({ servers });
    } catch (error) {
      logger.error('[adminUserManagement] list MCP servers failed', error);
      return res.status(500).json({ error: 'Failed to list MCP servers' });
    }
  }

  async function inviteUser(req: ServerRequest, res: Response): Promise<Response> {
    const body = req.body as InviteBody;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (!deps.checkEmailConfig()) {
      return res.status(503).json({ error: 'SMTP is not configured' });
    }

    const expiryDays = body.expiresInDays ?? 7;
    if (
      !Number.isInteger(expiryDays) ||
      expiryDays < MIN_EXPIRY_DAYS ||
      expiryDays > MAX_EXPIRY_DAYS
    ) {
      return res.status(400).json({ error: 'Expiry must be between 1 and 30 days' });
    }

    const existing = await deps.findUsers({ email }, '_id', { limit: 1 });
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }

    try {
      const available = new Set(await deps.resolveMCPServerNames(req));
      const accessError = validateMCPAccess(body.mcpAccess, available);
      if (accessError) {
        return res.status(400).json({ error: accessError });
      }
      const mcpAccess = normalizeMCPAccess(body.mcpAccess);
      await deps.deleteTokens({ email, type: 'invite' });
      const expiresIn = expiryDays * 24 * 60 * 60;
      const token = await createInvite(
        email,
        {
          createToken: deps.createToken,
          findToken: async () => null,
        },
        { expiresIn, metadata: { mcpAccess } },
      );
      if (typeof token !== 'string') {
        return res.status(500).json({ error: token.message });
      }

      const appName = process.env.APP_TITLE || 'LibreChat';
      const domain = process.env.DOMAIN_CLIENT || process.env.DOMAIN_SERVER || '';
      const inviteLink = `${domain}/register?token=${token}`;
      try {
        await deps.sendEmail({
          email,
          subject: `Invite to join ${appName}!`,
          payload: { appName, inviteLink, year: new Date().getFullYear() },
          template: 'inviteUser.handlebars',
        });
      } catch (error) {
        await deps.deleteTokens({ email, type: 'invite' });
        throw error;
      }
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      await audit(req, 'auth.user_invited', { name: email }, { expiresInDays: expiryDays });
      return res.status(201).json({ email, expiresAt });
    } catch (error) {
      logger.error('[adminUserManagement] invite failed', error);
      return res.status(500).json({ error: 'Failed to send invitation' });
    }
  }

  async function revokeInvite(req: ServerRequest, res: Response): Promise<Response> {
    const { email: rawEmail } = req.params as { email?: string };
    const email = (rawEmail ?? '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    try {
      const result = await deps.deleteTokens({ email, type: 'invite' });
      if (!result.deletedCount) {
        return res.status(404).json({ error: 'Invitation not found' });
      }
      await audit(req, 'auth.invite_revoked', { name: email });
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminUserManagement] revoke invitation failed', error);
      return res.status(500).json({ error: 'Failed to revoke invitation' });
    }
  }

  async function updateStatus(req: ServerRequest, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    const { blocked } = req.body as StatusBody;
    if (!isValidObjectIdString(id) || typeof blocked !== 'boolean') {
      return res.status(400).json({ error: 'Invalid status request' });
    }

    const caller = resolveCaller(req);
    if (blocked && caller?.id === id) {
      return res.status(400).json({ error: 'You cannot block your own account' });
    }

    try {
      const [target] = await deps.findUsers({ _id: id }, USER_FIELDS, { limit: 1 });
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (blocked && target.role === SystemRoles.ADMIN) {
        const activeAdmins = await deps.countUsers({
          role: SystemRoles.ADMIN,
          blocked: { $ne: true },
        });
        if (activeAdmins <= 1) {
          return res.status(400).json({ error: 'The last active admin cannot be blocked' });
        }
      }

      const updated = await deps.updateUser(id, {
        blocked,
        blockedAt: blocked ? new Date() : target.blockedAt,
        blockedBy: blocked && caller ? new Types.ObjectId(caller.id) : target.blockedBy,
      });
      if (!updated) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (blocked) {
        await deps.deleteAllUserSessions(id);
      }
      await audit(req, blocked ? 'auth.user_blocked' : 'auth.user_unblocked', {
        id,
        name: target.email,
      });
      return res.status(200).json({ user: mapUser(updated) });
    } catch (error) {
      logger.error('[adminUserManagement] status update failed', error);
      return res.status(500).json({ error: 'Failed to update user status' });
    }
  }

  async function updateMCPAccess(req: ServerRequest, res: Response): Promise<Response> {
    const { id } = req.params as { id: string };
    const { mcpAccess } = req.body as MCPAccessBody;
    if (!isValidObjectIdString(id)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    try {
      const available = new Set(await deps.resolveMCPServerNames(req));
      const accessError = validateMCPAccess(mcpAccess, available);
      if (accessError) {
        return res.status(400).json({ error: accessError });
      }
      const [target] = await deps.findUsers({ _id: id }, USER_FIELDS, { limit: 1 });
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }
      const normalized = normalizeMCPAccess(mcpAccess);
      const updated = await deps.updateUser(id, { mcpAccess: normalized });
      if (!updated) {
        return res.status(404).json({ error: 'User not found' });
      }
      await audit(
        req,
        'mcp.user_access_updated',
        { id, name: target.email },
        {
          policy: normalized.policy,
          servers: normalized.servers.join(','),
        },
      );
      return res.status(200).json({ user: mapUser(updated) });
    } catch (error) {
      logger.error('[adminUserManagement] MCP access update failed', error);
      return res.status(500).json({ error: 'Failed to update MCP access' });
    }
  }

  return {
    listUsers,
    listMCPServers,
    inviteUser,
    revokeInvite,
    updateStatus,
    updateMCPAccess,
  };
}
