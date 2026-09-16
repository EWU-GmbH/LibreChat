import { logger } from '@librechat/data-schemas';
import {
  Tools,
  Constants,
  isAgentsEndpoint,
  isEphemeralAgentId,
  encodeEphemeralAgentId,
} from 'librechat-data-provider';
import type {
  AgentModelParameters,
  TEphemeralAgent,
  TModelSpec,
  Agent,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { requiresEphemeralUserConnection } from '~/mcp/utils';
import { getCustomEndpointConfig } from '~/app/config';

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
    user?: { id?: string };
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
  const tools: string[] = [];
  const userId = req.user?.id ?? '';

  for (const serverName of new Set(serverNames)) {
    const overlayConfig = req.config?.mcpConfig?.[serverName];
    const serverTools =
      overlayConfig && requiresEphemeralUserConnection(overlayConfig)
        ? null
        : await deps.getMCPServerTools(userId, serverName);

    if (!serverTools) {
      tools.push(`${mcp_all}${mcp_delimiter}${serverName}`);
      continue;
    }
    tools.push(...Object.keys(serverTools));
  }

  return tools;
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
  return result as Agent;
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
  const selectedServers = req.body?.ephemeralAgent?.mcp?.slice(-1) ?? [];
  if (selectedServers.length === 0) {
    return baselineTools.length === agent.tools?.length
      ? agent
      : {
          ...agent,
          tools: baselineTools,
        };
  }

  const selectedTools = await getSelectedMCPTools(req, selectedServers, deps);
  const tools = new Set(baselineTools);
  selectedTools.forEach((tool) => tools.add(tool));

  return {
    ...agent,
    tools: Array.from(tools),
  };
}
