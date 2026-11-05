import { normalizeMCPSelection } from '../normalizeMCPSelection';

describe('normalizeMCPSelection', () => {
  it('keeps every unique server name in order', () => {
    expect(normalizeMCPSelection(['server1', 'server2', 'server1', ''])).toEqual([
      'server1',
      'server2',
    ]);
  });

  it('drops non-string and empty entries without reordering survivors', () => {
    expect(
      normalizeMCPSelection(['alpha', '', 'beta', 'alpha', undefined as unknown as string]),
    ).toEqual(['alpha', 'beta']);
  });
});
