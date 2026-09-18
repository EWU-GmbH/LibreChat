import { logger } from '@librechat/data-schemas';
import {
  Tools,
  Constants,
  isAgentsEndpoint,
  isEphemeralAgentId,
  encodeEphemeralAgentId,
} from 'librechat-data-provider';
import type {
  AgentToolOptions,
  AgentModelParameters,
  TEphemeralAgent,
  UserMCPAccess,
  TModelSpec,
  Agent,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { requiresEphemeralUserConnection } from '~/mcp/utils';
import { getCustomEndpointConfig } from '~/app/config';
import { canAccessMCPServer } from '~/mcp/access';

const { mcp_all, mcp_delimiter } = Constants;
type ModelParametersWithPromptPrefix = AgentModelParameters & { promptPrefix?: string | null };

export interface LoadAgentDeps {
  getAgent: (searchParameter: { id: string }) => Promise<Agent | null>;
  getMCPServerTools: (
    userId: string,
    serverName: string,
  ) => Promise<Record<string, unknown> | null>;
}

export interface LoadAgentParams {
  req: {
    user?: { id?: string; role?: string; mcpAccess?: UserMCPAccess };
    config?: AppConfig;
    body?: {
      promptPrefix?: string;
      ephemeralAgent?: TEphemeralAgent;
    };
  };
  spec?: string;
  agent_id: string;
  endpoint: string;
  model_parameters?: AgentModelParameters & { model?: string };
}

async function getSelectedMCPTools(
  req: LoadAgentParams['req'],
  serverNames: Iterable<string>,
  deps: LoadAgentDeps,
): Promise<string[]> {
  const userId = req.user?.id ?? '';
  const uniqueServers = [...new Set(serverNames)];

  const results = await Promise.allSettled(
    uniqueServers.map(async (serverName) => {
      if (!canAccessMCPServer(req.user, serverName)) {
        logger.warn(
          `[getSelectedMCPTools] Denied MCP server '${serverName}' for user ${userId} (mcpAccess policy)`,
        );
        return [] as string[];
      }

      const overlayConfig = req.config?.mcpConfig?.[serverName];
      const serverTools =
        overlayConfig && requiresEphemeralUserConnection(overlayConfig)
          ? null
          : await deps.getMCPServerTools(userId, serverName);

      if (!serverTools) {
        return [`${mcp_all}${mcp_delimiter}${serverName}`];
      }
      return Object.keys(serverTools);
    }),
  );

  const tools: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      tools.push(...result.value);
      continue;
    }
    logger.warn(
      `[getSelectedMCPTools] Failed to load tools for '${uniqueServers[i]}':`,
      result.reason,
    );
  }

  return tools;
}

function applyDeferredMcpToolOptions(
  agent: Agent,
  mcpToolNames: string[],
  selectedServerCount: number,
): Agent {
  if (selectedServerCount <= 1 || mcpToolNames.length === 0) {
    return agent;
  }

  const tool_options: AgentToolOptions = { ...(agent.tool_options ?? {}) };
  for (const name of mcpToolNames) {
    tool_options[name] = {
      ...tool_options[name],
      defer_loading: true,
    };
  }

  return {
    ...agent,
    tool_options,
  };
}

/**
 * Load an ephemeral agent based on the request parameters.
 */
export async function loadEphemeralAgent(
  { req, spec, endpoint, model_parameters: _m }: Omit<LoadAgentParams, 'agent_id'>,
  deps: LoadAgentDeps,
): Promise<Agent | null> {
  const { model, ...model_parameters } = _m ?? ({} as unknown as AgentModelParameters);
  const modelSpecs = req.config?.modelSpecs as { list?: TModelSpec[] } | undefined;
  let modelSpec: TModelSpec | null = null;
  if (spec != null && spec !== '') {
    modelSpec = modelSpecs?.list?.find((s) => s.name === spec) ?? null;
  }
  const ephemeralAgent: TEphemeralAgent | undefined = req.body?.ephemeralAgent;
  const mcpServers = new Set<string>(ephemeralAgent?.mcp);
  if (modelSpec?.mcpServers) {
    for (const mcpServer of modelSpec.mcpServers) {
      mcpServers.add(mcpServer);
    }
  }
  const tools: string[] = [];
  if (ephemeralAgent?.execute_code === true || modelSpec?.executeCode === true) {
    tools.push(Tools.execute_code);
  }
  if (ephemeralAgent?.file_search === true || modelSpec?.fileSearch === true) {
    tools.push(Tools.file_search);
  }
  if (ephemeralAgent?.web_search === true || modelSpec?.webSearch === true) {
    tools.push(Tools.web_search);
  }

  tools.push(...(await getSelectedMCPTools(req, mcpServers, deps)));
  tools.push(Tools.request_mcp);

  const requestPromptPrefix = req.body?.promptPrefix;
  const { promptPrefix: modelPromptPrefix, ...safeModelParameters } =
    model_parameters as ModelParametersWithPromptPrefix;
  const instructions =
    typeof modelPromptPrefix === 'string' ? modelPromptPrefix : requestPromptPrefix;

  // Get endpoint config for modelDisplayLabel fallback
  const appConfig = req.config;
  const endpoints = appConfig?.endpoints;
  let endpointConfig = endpoints?.[endpoint as keyof typeof endpoints];
  if (!isAgentsEndpoint(endpoint) && !endpointConfig) {
    try {
      endpointConfig = getCustomEndpointConfig({ endpoint, appConfig });
    } catch (err) {
      logger.error('[loadEphemeralAgent] Error getting custom endpoint config', err);
    }
  }

  // For ephemeral agents, use modelLabel if provided, then model spec's label,
  // then modelDisplayLabel from endpoint config, otherwise empty string to show model name
  const sender =
    (model_parameters as AgentModelParameters & { modelLabel?: string })?.modelLabel ??
    modelSpec?.label ??
    (endpointConfig as { modelDisplayLabel?: string } | undefined)?.modelDisplayLabel ??
    '';

  // Encode ephemeral agent ID with endpoint, model, and computed sender for display
  const ephemeralId = encodeEphemeralAgentId({
    endpoint,
    model: model as string,
    sender: sender as string,
  });

  const result: Partial<Agent> = {
    id: ephemeralId,
    instructions,
    provider: endpoint,
    model_parameters: safeModelParameters as AgentModelParameters,
    model,
    tools,
  };

  if (ephemeralAgent?.artifacts) {
    result.artifacts = ephemeralAgent.artifacts;
  }
  if (modelSpec?.subagents) {
    result.subagents = modelSpec.subagents;
  }
  if (modelSpec && Object.prototype.hasOwnProperty.call(modelSpec, 'skills')) {
    if (modelSpec.skills === true) {
      result.skills_enabled = true;
    } else if (modelSpec.skills === false) {
      result.skills_enabled = false;
      result.skills = [];
    } else if (Array.isArray(modelSpec.skills)) {
      result.skills_enabled = true;
      result.skills = [];
    }
  }
  return applyDeferredMcpToolOptions(
    result as Agent,
    tools.filter((tool) => tool.includes(mcp_delimiter)),
    mcpServers.size,
  );
}

/**
 * Load an agent based on the provided ID.
 * For ephemeral agents, builds a synthetic agent from request parameters.
 * For persistent agents, fetches from the database.
 */
export async function loadAgent(
  params: LoadAgentParams,
  deps: LoadAgentDeps,
): Promise<Agent | null> {
  const { req, spec, agent_id, endpoint, model_parameters } = params;
  if (!agent_id) {
    return null;
  }
  if (isEphemeralAgentId(agent_id)) {
    return loadEphemeralAgent({ req, spec, endpoint, model_parameters }, deps);
  }
  const agent = await deps.getAgent({ id: agent_id });

  if (!agent) {
    return null;
  }

  // Set version count from versions array length
  const agentWithVersion = agent as Agent & { versions?: unknown[]; version?: number };
  agentWithVersion.version = agentWithVersion.versions ? agentWithVersion.versions.length : 0;

  const baselineTools = (agent.tools ?? []).filter((tool) => !tool.includes(mcp_delimiter));
  const selectedServers = [...new Set(req.body?.ephemeralAgent?.mcp ?? [])];
  if (selectedServers.length === 0) {
    return {
      ...agent,
      tools: [...baselineTools, Tools.request_mcp],
    };
  }

  const selectedTools = await getSelectedMCPTools(req, selectedServers, deps);
  const tools = new Set(baselineTools);
  selectedTools.forEach((tool) => tools.add(tool));
  tools.add(Tools.request_mcp);

  return applyDeferredMcpToolOptions(
    {
      ...agent,
      tools: Array.from(tools),
    },
    selectedTools,
    selectedServers.length,
  );
}
