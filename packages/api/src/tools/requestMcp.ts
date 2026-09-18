import { z } from 'zod';
import { Tools } from 'librechat-data-provider';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import { canAccessMCPServer } from '~/mcp/access';
import { listChatSelectableMcpServers } from '~/mcp/chatServers';
import type { UserMCPAccess } from 'librechat-data-provider';
import type { ChatSelectableMcpConfig } from '~/mcp/chatServers';

export interface RequestMcpDefinition {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, { type: 'string'; description: string }>;
    required: string[];
  };
}

export const RequestMcpToolDefinition: RequestMcpDefinition = {
  name: Tools.request_mcp,
  description:
    'Ask the user to enable an MCP server required by a skill or task. Call this instead of guessing tools when the needed MCP is not active. Do not continue as if the tools were available.',
  schema: {
    type: 'object',
    properties: {
      serverName: {
        type: 'string',
        description: 'Exact MCP server name from the skill mcp-servers mapping.',
      },
      reason: {
        type: 'string',
        description: 'Short explanation shown to the user.',
      },
    },
    required: ['serverName'],
  },
};

export function resolveRequestableMcpServers(params: {
  mcpConfig: Record<string, ChatSelectableMcpConfig | undefined> | undefined;
  selectedServers?: string[];
  user?: { id?: string; role?: string; mcpAccess?: UserMCPAccess };
}): string[] {
  const selected = new Set(params.selectedServers ?? []);
  return listChatSelectableMcpServers(params.mcpConfig).filter((serverName) => {
    if (selected.has(serverName)) {
      return false;
    }
    return canAccessMCPServer(params.user, serverName);
  });
}

export function createRequestMcpTool(params: {
  availableServers: string[];
}): DynamicStructuredTool {
  const available = new Set(params.availableServers);
  const [firstServer, ...otherServers] = params.availableServers;
  const serverNameSchema =
    firstServer != null
      ? z.enum([firstServer, ...otherServers] as [string, ...string[]])
      : z.string().min(1);
  return new DynamicStructuredTool({
    name: Tools.request_mcp,
    description: RequestMcpToolDefinition.description,
    schema: z.object({
      serverName: serverNameSchema,
      reason: z.string().optional(),
    }),
    func: async ({ serverName, reason }) => {
      if (!available.has(serverName)) {
        return JSON.stringify({
          type: Tools.request_mcp,
          error: 'not_available',
          serverName,
        });
      }
      return JSON.stringify({
        type: Tools.request_mcp,
        serverName,
        reason: reason ?? '',
      });
    },
  });
}
