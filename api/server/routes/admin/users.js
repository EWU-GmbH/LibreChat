const express = require('express');
const {
  checkEmailConfig,
  createAdminUsersHandlers,
  createAdminUserManagementHandlers,
} = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { resolveMcpConfigNames } = require('~/server/services/MCP');
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

const managementHandlers = createAdminUserManagementHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  updateUser: db.updateUser,
  deleteAllUserSessions: db.deleteAllUserSessions,
  createToken: db.createToken,
  deleteTokens: db.deleteTokens,
  sendEmail,
  checkEmailConfig,
  resolveMCPServerNames: resolveMcpConfigNames,
  recordAuditEntry: db.recordAuditEntry,
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', requireReadUsers, managementHandlers.listUsers);
router.get('/search', requireReadUsers, handlers.searchUsers);
router.get('/mcp-servers', requireReadUsers, managementHandlers.listMCPServers);
router.post('/invites', requireManageUsers, managementHandlers.inviteUser);
router.delete('/invites/:email', requireManageUsers, managementHandlers.revokeInvite);
router.patch('/:id/status', requireManageUsers, managementHandlers.updateStatus);
router.put('/:id/mcp-access', requireManageUsers, managementHandlers.updateMCPAccess);

module.exports = router;
