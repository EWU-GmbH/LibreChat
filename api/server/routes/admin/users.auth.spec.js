const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  checkEmailConfig: jest.fn(() => true),
  createAdminUsersHandlers: jest.fn(() => ({
    searchUsers: (_req, res) => res.status(200).json({ users: [] }),
  })),
  createAdminUserManagementHandlers: jest.fn(() => ({
    listUsers: (_req, res) => res.status(200).json({ users: [] }),
    listMCPServers: (_req, res) => res.status(200).json({ servers: [] }),
    inviteUser: (_req, res) => res.status(201).json({}),
    revokeInvite: (_req, res) => res.status(200).json({}),
    updateStatus: (_req, res) => res.status(200).json({}),
    updateMCPAccess: (_req, res) => res.status(200).json({}),
  })),
}));

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: {
    ACCESS_ADMIN: 'access:admin',
    READ_USERS: 'read:users',
    MANAGE_USERS: 'manage:users',
  },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'test-user', role: req.get('x-test-role') };
    next();
  },
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (req, res, next) =>
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' }),
}));

jest.mock('~/server/services/MCP', () => ({
  resolveMcpConfigNames: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(),
}));

jest.mock('~/models', () => ({}));

const usersRouter = require('./users');

describe('admin users route authorization', () => {
  const app = express().use(express.json()).use('/api/admin/users', usersRouter);

  it('returns 403 for a non-admin user', async () => {
    const res = await request(app).get('/api/admin/users').set('x-test-role', 'user');
    expect(res.status).toBe(403);
  });

  it('allows an administrator to list users', async () => {
    const res = await request(app).get('/api/admin/users').set('x-test-role', 'admin');
    expect(res.status).toBe(200);
  });
});
