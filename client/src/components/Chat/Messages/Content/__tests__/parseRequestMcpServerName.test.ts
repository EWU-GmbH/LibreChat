/** @jest-environment node */

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
});
