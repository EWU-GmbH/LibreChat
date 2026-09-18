/** @jest-environment node */

import { normalizeMCPSelection } from '../useMCPSelect';

describe('normalizeMCPSelection', () => {
  it('keeps every unique server name in order', () => {
    expect(normalizeMCPSelection(['server1', 'server2', 'server1', ''])).toEqual([
      'server1',
      'server2',
    ]);
  });
});
