export const MCP_ACCESS_POLICIES = ['all', 'allowlist'] as const;

export type MCPAccessPolicy = (typeof MCP_ACCESS_POLICIES)[number];

export type UserMCPAccess = {
  policy: MCPAccessPolicy;
  servers: string[];
};

export type AdminUser = {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
  provider: string;
  blocked: boolean;
  lastLoginAt?: string;
  createdAt?: string;
  mcpAccess: UserMCPAccess;
};

export type AdminUsersPage = {
  users: AdminUser[];
  nextCursor?: string;
};

export type AdminUsersParams = {
  cursor?: string;
  limit?: number;
  search?: string;
};

export type AdminInviteUserRequest = {
  email: string;
  expiresInDays?: number;
  mcpAccess: UserMCPAccess;
};

export type AdminInviteUserResponse = {
  email: string;
  expiresAt: string;
};

export type AdminMCPServersResponse = {
  servers: string[];
};

export type AdminUpdateUserStatusRequest = {
  blocked: boolean;
};

export type AdminUpdateMCPAccessRequest = {
  mcpAccess: UserMCPAccess;
};
