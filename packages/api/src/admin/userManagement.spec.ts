import { Types } from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { AdminUserManagementDeps } from './userManagement';
import type { ServerRequest } from '~/types/http';
import { createAdminUserManagementHandlers } from './userManagement';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  getRandomValues: jest.fn().mockResolvedValue('invite-token'),
  hashToken: jest.fn().mockResolvedValue('invite-hash'),
}));

function user(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(),
    id: '',
    email: 'user@example.com',
    provider: 'local',
    role: SystemRoles.USER,
    blocked: false,
    ...overrides,
  } as IUser;
}

function request(
  options: {
    query?: Record<string, string>;
    params?: Record<string, string>;
    body?: object;
  } = {},
): ServerRequest {
  return {
    query: options.query ?? {},
    params: options.params ?? {},
    body: options.body ?? {},
    headers: {},
    user: user({ role: SystemRoles.ADMIN, email: 'admin@example.com' }),
  } as ServerRequest;
}

function response(): {
  res: Response;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status } as unknown as Response, status, json };
}

function dependencies(overrides: Partial<AdminUserManagementDeps> = {}): AdminUserManagementDeps {
  return {
    findUsers: jest.fn().mockResolvedValue([]),
    countUsers: jest.fn().mockResolvedValue(2),
    updateUser: jest.fn().mockImplementation((_id, update) => user(update)),
    deleteAllUserSessions: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    createToken: jest.fn().mockResolvedValue({}),
    deleteTokens: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    sendEmail: jest.fn().mockResolvedValue(undefined),
    checkEmailConfig: jest.fn().mockReturnValue(true),
    resolveMCPServerNames: jest.fn().mockResolvedValue(['dataforseo', 'formbricks', 'listmonk']),
    recordAuditEntry: jest.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('admin user management handlers', () => {
  it('uses an opaque cursor and returns the next page cursor', async () => {
    const first = user();
    const second = user();
    const deps = dependencies({ findUsers: jest.fn().mockResolvedValue([first, second]) });
    const handlers = createAdminUserManagementHandlers(deps);
    const { res, json } = response();

    await handlers.listUsers(request({ query: { limit: '1' } }), res);

    const page = json.mock.calls[0][0];
    expect(page.users).toHaveLength(1);
    expect(page.nextCursor).toBe(Buffer.from(first._id.toString()).toString('base64url'));

    const nextResponse = response();
    await handlers.listUsers(
      request({ query: { limit: '1', cursor: page.nextCursor } }),
      nextResponse.res,
    );
    expect(deps.findUsers).toHaveBeenLastCalledWith(
      { _id: { $lt: first._id } },
      expect.any(String),
      { limit: 2, sort: { _id: -1 } },
    );
  });

  it('returns a clear error when SMTP is unavailable', async () => {
    const deps = dependencies({ checkEmailConfig: jest.fn().mockReturnValue(false) });
    const handlers = createAdminUserManagementHandlers(deps);
    const { res, status, json } = response();

    await handlers.inviteUser(
      request({
        body: {
          email: 'new@example.com',
          expiresInDays: 7,
          mcpAccess: { policy: 'all', servers: [] },
        },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({ error: 'SMTP is not configured' });
    expect(deps.createToken).not.toHaveBeenCalled();
  });

  it('creates and emails a seven-day invitation with MCP defaults', async () => {
    const deps = dependencies();
    const handlers = createAdminUserManagementHandlers(deps);
    const { res, status } = response();

    await handlers.inviteUser(
      request({
        body: {
          email: 'new@example.com',
          expiresInDays: 7,
          mcpAccess: { policy: 'allowlist', servers: ['formbricks'] },
        },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(201);
    expect(deps.deleteTokens).toHaveBeenCalledWith({
      email: 'new@example.com',
      type: 'invite',
    });
    expect(deps.createToken).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@example.com',
        type: 'invite',
        expiresIn: 604800,
        metadata: {
          mcpAccess: { policy: 'allowlist', servers: ['formbricks'] },
        },
      }),
    );
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('revokes the token when the external mail delivery fails', async () => {
    const deleteTokens = jest
      .fn()
      .mockResolvedValueOnce({ deletedCount: 0 })
      .mockResolvedValueOnce({ deletedCount: 1 });
    const deps = dependencies({
      deleteTokens,
      sendEmail: jest.fn().mockRejectedValue(new Error('SMTP rejected message')),
    });
    const handlers = createAdminUserManagementHandlers(deps);
    const { res, status } = response();

    await handlers.inviteUser(
      request({
        body: {
          email: 'new@example.com',
          mcpAccess: { policy: 'all', servers: [] },
        },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(deleteTokens).toHaveBeenLastCalledWith({
      email: 'new@example.com',
      type: 'invite',
    });
    expect(deleteTokens).toHaveBeenCalledTimes(2);
  });

  it('blocks a user and invalidates all sessions', async () => {
    const target = user();
    const deps = dependencies({
      findUsers: jest.fn().mockResolvedValue([target]),
      updateUser: jest.fn().mockResolvedValue(user({ blocked: true })),
    });
    const handlers = createAdminUserManagementHandlers(deps);
    const { res, status } = response();

    await handlers.updateStatus(
      request({ params: { id: target._id.toString() }, body: { blocked: true } }),
      res,
    );

    expect(status).toHaveBeenCalledWith(200);
    expect(deps.updateUser).toHaveBeenCalledWith(
      target._id.toString(),
      expect.objectContaining({ blocked: true }),
    );
    expect(deps.deleteAllUserSessions).toHaveBeenCalledWith(target._id.toString());
  });

  it('does not block the last active administrator', async () => {
    const target = user({ role: SystemRoles.ADMIN });
    const deps = dependencies({
      findUsers: jest.fn().mockResolvedValue([target]),
      countUsers: jest.fn().mockResolvedValue(1),
    });
    const handlers = createAdminUserManagementHandlers(deps);
    const { res, status } = response();

    await handlers.updateStatus(
      request({ params: { id: target._id.toString() }, body: { blocked: true } }),
      res,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('persists a validated MCP allowlist', async () => {
    const target = user();
    const deps = dependencies({
      findUsers: jest.fn().mockResolvedValue([target]),
      updateUser: jest
        .fn()
        .mockResolvedValue(user({ mcpAccess: { policy: 'allowlist', servers: ['dataforseo'] } })),
    });
    const handlers = createAdminUserManagementHandlers(deps);
    const { res, status } = response();

    await handlers.updateMCPAccess(
      request({
        params: { id: target._id.toString() },
        body: { mcpAccess: { policy: 'allowlist', servers: ['dataforseo'] } },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(200);
    expect(deps.updateUser).toHaveBeenCalledWith(target._id.toString(), {
      mcpAccess: { policy: 'allowlist', servers: ['dataforseo'] },
    });
  });
});
