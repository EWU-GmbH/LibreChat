import React from 'react';
import { render, screen } from '@testing-library/react';
import BadgeRow from '../BadgeRow';

const mcpSelectProps: Array<{ alwaysVisible?: boolean }> = [];

jest.mock('recoil', () => ({
  useRecoilValue: () => false,
  useRecoilCallback: () => () => undefined,
}));

jest.mock('~/hooks', () => ({
  useChatBadges: () => [],
}));

jest.mock('~/Providers', () => ({
  BadgeRowProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { isEditingBadges: 'isEditingBadges' },
}));

jest.mock('@librechat/client', () => ({
  Badge: () => null,
}));

jest.mock('../ToolsDropdown', () => ({
  __esModule: true,
  default: () => <div data-testid="tools-dropdown" />,
}));

jest.mock('../WebSearch', () => ({
  __esModule: true,
  default: () => <div data-testid="web-search" />,
}));

jest.mock('../CodeInterpreter', () => ({
  __esModule: true,
  default: () => <div data-testid="code-interpreter" />,
}));

jest.mock('../FileSearch', () => ({
  __esModule: true,
  default: () => <div data-testid="file-search" />,
}));

jest.mock('../Skills', () => ({
  __esModule: true,
  default: () => <div data-testid="skills" />,
}));

jest.mock('../Artifacts', () => ({
  __esModule: true,
  default: () => <div data-testid="artifacts" />,
}));

jest.mock('../ToolDialogs', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../MCPSelect', () => ({
  __esModule: true,
  default: (props: { alwaysVisible?: boolean }) => {
    mcpSelectProps.push(props);
    return <div data-testid="mcp-select" />;
  },
}));

jest.mock('../PIIProtection', () => ({
  __esModule: true,
  default: () => <div data-testid="pii-protection" />,
}));

describe('BadgeRow', () => {
  beforeEach(() => {
    mcpSelectProps.length = 0;
  });

  it('renders the MCP picker without ephemeral badges for agent conversations', () => {
    render(
      <BadgeRow showEphemeralBadges={false} showMCPSelect={true} onChange={jest.fn()} isInChat />,
    );

    expect(screen.getByTestId('mcp-select')).toBeInTheDocument();
    expect(screen.queryByTestId('web-search')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tools-dropdown')).not.toBeInTheDocument();
    expect(mcpSelectProps).toEqual([{ alwaysVisible: true }]);
  });

  it('renders PII protection independently of agent tool badges', () => {
    render(
      <BadgeRow
        showEphemeralBadges={false}
        showMCPSelect={true}
        showPIIProtection={true}
        onChange={jest.fn()}
        isInChat
      />,
    );

    expect(screen.getByTestId('pii-protection')).toBeInTheDocument();
    expect(screen.queryByTestId('web-search')).not.toBeInTheDocument();
  });

  it('renders the MCP picker alongside ephemeral badges and keeps it pin-driven', () => {
    render(
      <BadgeRow showEphemeralBadges={true} showMCPSelect={true} onChange={jest.fn()} isInChat />,
    );

    expect(screen.getByTestId('mcp-select')).toBeInTheDocument();
    expect(screen.getByTestId('web-search')).toBeInTheDocument();
    expect(screen.getByTestId('tools-dropdown')).toBeInTheDocument();
    expect(mcpSelectProps).toEqual([{ alwaysVisible: false }]);
  });

  it('omits the MCP picker when the endpoint does not support it', () => {
    render(
      <BadgeRow showEphemeralBadges={false} showMCPSelect={false} onChange={jest.fn()} isInChat />,
    );

    expect(screen.queryByTestId('mcp-select')).not.toBeInTheDocument();
    expect(mcpSelectProps).toEqual([]);
  });
});
