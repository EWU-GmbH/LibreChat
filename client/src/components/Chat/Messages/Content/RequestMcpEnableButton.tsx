import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useRecoilState } from 'recoil';
import { Button } from '@librechat/client';
import { Constants } from 'librechat-data-provider';
import { ChatContext } from '~/Providers/ChatContext';
import { useBadgeRowContext } from '~/Providers/BadgeRowContext';
import { ephemeralAgentByConvoId } from '~/store';
import { parseRequestMcpServerName } from './parseRequestMcp';
import { useLocalize } from '~/hooks';

export { parseRequestMcpServerName } from './parseRequestMcp';

export default function RequestMcpEnableButton({
  args,
  output,
}: {
  args?: string | Record<string, unknown>;
  output?: string | null;
}) {
  const localize = useLocalize();
  const serverName = parseRequestMcpServerName(args, output);
  const chat = useContext(ChatContext);
  const badgeRow = useBadgeRowContext();
  const conversationId = chat?.conversation?.conversationId ?? Constants.NEW_CONVO;
  const [ephemeralAgent, setEphemeralAgent] = useRecoilState(
    ephemeralAgentByConvoId(conversationId),
  );
  const [isEnabling, setIsEnabling] = useState(false);
  const pendingOAuthServer = useRef<string | null>(null);

  const resubmit = useCallback(() => {
    const messages = chat?.getMessages?.() ?? [];
    const latest =
      messages.find((message) => message.messageId === chat?.latestMessageId) ??
      messages[messages.length - 1];
    if (!latest) {
      return;
    }
    chat?.regenerate({
      messageId: latest.messageId,
      parentMessageId: latest.parentMessageId,
      isCreatedByUser: latest.isCreatedByUser,
    });
  }, [chat]);

  const mcpValues = badgeRow?.mcpServerManager.mcpValues ?? ephemeralAgent?.mcp ?? [];

  useEffect(() => {
    const pending = pendingOAuthServer.current;
    if (!pending || !mcpValues.includes(pending)) {
      return;
    }
    pendingOAuthServer.current = null;
    resubmit();
  }, [mcpValues, resubmit]);

  const handleEnable = useCallback(async () => {
    if (!serverName || isEnabling) {
      return;
    }
    setIsEnabling(true);
    try {
      const manager = badgeRow?.mcpServerManager;
      if (manager) {
        const alreadySelected = manager.mcpValues.includes(serverName);
        if (!alreadySelected) {
          const response = await manager.initializeServer(serverName);
          if (response?.oauthRequired) {
            pendingOAuthServer.current = serverName;
            return;
          }
        }
      } else {
        const current = ephemeralAgent?.mcp ?? [];
        if (!current.includes(serverName)) {
          setEphemeralAgent({ ...(ephemeralAgent ?? {}), mcp: [...current, serverName] });
        }
      }
      resubmit();
    } finally {
      setIsEnabling(false);
    }
  }, [
    badgeRow?.mcpServerManager,
    ephemeralAgent,
    isEnabling,
    resubmit,
    serverName,
    setEphemeralAgent,
  ]);

  if (!serverName) {
    return null;
  }

  return (
    <div className="mb-1 mt-2">
      <Button
        className="inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium"
        variant="default"
        disabled={isEnabling}
        onClick={handleEnable}
        aria-label={localize('com_ui_mcp_enable_server', { 0: serverName })}
      >
        {localize('com_ui_mcp_enable_server', { 0: serverName })}
      </Button>
    </div>
  );
}
