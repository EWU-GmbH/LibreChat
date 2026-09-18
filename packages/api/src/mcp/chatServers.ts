export type ChatSelectableMcpConfig = {
  chatMenu?: boolean;
  consumeOnly?: boolean;
};

export function isChatSelectableMcpServer(config: ChatSelectableMcpConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  return config.chatMenu !== false && config.consumeOnly !== true;
}

export function listChatSelectableMcpServers(
  mcpConfig: Record<string, ChatSelectableMcpConfig | undefined> | undefined,
): string[] {
  if (!mcpConfig) {
    return [];
  }
  return Object.entries(mcpConfig)
    .filter(([, config]) => isChatSelectableMcpServer(config))
    .map(([serverName]) => serverName);
}
