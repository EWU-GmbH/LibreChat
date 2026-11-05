import type { SkillSource } from '../src/types/skills';

/**
 * Exhaustive lock for `SkillSource`. Adding/removing a union member without
 * updating this map fails typecheck — guards the MCP stub source against
 * drifting out of the shared wire type again.
 */
const SKILL_SOURCES = {
  inline: true,
  deployment: true,
  github: true,
  notion: true,
  mcp: true,
} as const satisfies Record<SkillSource, true>;

describe('SkillSource', () => {
  it('includes mcp for auto-generated chat MCP stub skills', () => {
    expect(Object.keys(SKILL_SOURCES).sort()).toEqual(
      ['deployment', 'github', 'inline', 'mcp', 'notion'].sort(),
    );
  });
});
