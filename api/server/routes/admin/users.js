const express = require('express');
const mongoose = require('mongoose');
const {
  checkEmailConfig,
  createAdminUsersHandlers,
  createAdminUserManagementHandlers,
} = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { resolveMcpConfigNames } = require('~/server/services/MCP');
const { requestPasswordReset } = require('~/server/services/AuthService');
const { sendEmail } = require('~/server/utils');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);

const handlers = createAdminUsersHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  deleteUserById: db.deleteUserById,
  deleteConfig: db.deleteConfig,
  deleteAclEntries: db.deleteAclEntries,
});

async function findPendingInvites() {
  const Token = mongoose.models.Token;
  const tokens = await Token.find({
    type: 'invite',
    expiresAt: { $gt: new Date() },
  })
    .select('email expiresAt createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const seen = new Set();
  const invites = [];
  for (const token of tokens) {
    const email = typeof token.email === 'string' ? token.email.trim().toLowerCase() : '';
    if (!email || seen.has(email)) {
      continue;
    }
    seen.add(email);
    invites.push({
      email,
      expiresAt:
        token.expiresAt instanceof Date
          ? token.expiresAt.toISOString()
          : new Date(token.expiresAt).toISOString(),
      createdAt:
        token.createdAt instanceof Date
          ? token.createdAt.toISOString()
          : token.createdAt
            ? new Date(token.createdAt).toISOString()
            : undefined,
    });
  }
  return invites;
}

async function sendPasswordReset(user, req) {
  const result = await requestPasswordReset({
    ...req,
    body: { email: user.email },
  });
  if (result instanceof Error) {
    throw result;
  }
}

const managementHandlers = createAdminUserManagementHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  updateUser: db.updateUser,
  deleteAllUserSessions: db.deleteAllUserSessions,
  createToken: db.createToken,
  deleteTokens: db.deleteTokens,
  findPendingInvites,
  sendPasswordReset,
  sendEmail,
  checkEmailConfig,
  resolveMCPServerNames: resolveMcpConfigNames,
  recordAuditEntry: db.recordAuditEntry,
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', requireReadUsers, managementHandlers.listUsers);
router.get('/search', requireReadUsers, handlers.searchUsers);
router.get('/mcp-servers', requireReadUsers, managementHandlers.listMCPServers);
router.get('/invites', requireReadUsers, managementHandlers.listInvites);
router.post('/invites', requireManageUsers, managementHandlers.inviteUser);
router.delete('/invites/:email', requireManageUsers, managementHandlers.revokeInvite);
router.patch('/:id/status', requireManageUsers, managementHandlers.updateStatus);
router.put('/:id/mcp-access', requireManageUsers, managementHandlers.updateMCPAccess);
router.post('/:id/resend-access', requireManageUsers, managementHandlers.resendAccess);
router.delete('/:id', requireManageUsers, handlers.deleteUser);

module.exports = router;
