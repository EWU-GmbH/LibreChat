import { parseRequestMcpServerName } from '../parseRequestMcp';

describe('parseRequestMcpServerName', () => {
  it('reads serverName from JSON args or output', () => {
    expect(parseRequestMcpServerName('{"serverName":"formbricks"}')).toBe('formbricks');
    expect(parseRequestMcpServerName(undefined, '{"serverName":"dataforseo"}')).toBe(
      'dataforseo',
    );
    expect(parseRequestMcpServerName({ serverName: 'listmonk' })).toBe('listmonk');
    expect(parseRequestMcpServerName('not-json')).toBe('');
  });

  it('prefers args over output when both provide serverName', () => {
    expect(
      parseRequestMcpServerName(
        { serverName: 'from-args' },
        '{"serverName":"from-output"}',
      ),
    ).toBe('from-args');
  });
});
