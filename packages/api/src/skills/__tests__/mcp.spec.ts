import mongoose from 'mongoose';
import { Types } from 'mongoose';
import type { ISkillDocument } from '@librechat/data-schemas';
import {
  getMcpSkillIds,
  mergeMcpSkillIds,
  mcpStubSkillName,
  syncMcpSkills,
} from '../mcp';

type SkillRow = Partial<ISkillDocument> & {
  _id: Types.ObjectId;
  source?: string;
  mcpServers?: string[];
  sourceMetadata?: { serverName?: string };
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  name?: string;
};

function matchesQuery(doc: SkillRow, query: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(query)) {
    if (key === 'source' && typeof value === 'object' && value && '$ne' in value) {
      if (doc.source === (value as { $ne: string }).$ne) {
        return false;
      }
      continue;
    }
    if (key === 'mcpServers' && typeof value === 'object' && value && '$exists' in value) {
      if (!Array.isArray(doc.mcpServers) || doc.mcpServers.length === 0) {
        return false;
      }
      continue;
    }
    if (key === 'sourceMetadata.serverName') {
      if (typeof value === 'object' && value && '$nin' in value) {
        const nin = (value as { $nin: string[] }).$nin;
        if (nin.includes(doc.sourceMetadata?.serverName ?? '')) {
          return false;
        }
        continue;
      }
      if (doc.sourceMetadata?.serverName !== value) {
        return false;
      }
      continue;
    }
    if (key === 'disableModelInvocation' && typeof value === 'object' && value && '$ne' in value) {
      if (doc.disableModelInvocation === (value as { $ne: boolean }).$ne) {
        return false;
      }
      continue;
    }
    if (key.includes('.')) {
      continue;
    }
    if ((doc as Record<string, unknown>)[key] !== value) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc: SkillRow, update: { $set?: Record<string, unknown> }): void {
  Object.assign(doc, update.$set ?? {});
}

function createSkillModel(docs: SkillRow[]) {
  return {
    find: (query: Record<string, unknown>) => ({
      select: () => ({
        lean: async () => docs.filter((doc) => matchesQuery(doc, query)),
      }),
    }),
    findOne: (query: Record<string, unknown>) => ({
      lean: async () => docs.find((doc) => matchesQuery(doc, query)) ?? null,
    }),
    updateMany: async (query: Record<string, unknown>, update: { $set?: Record<string, unknown> }) => {
      for (const doc of docs.filter((row) => matchesQuery(row, query))) {
        applyUpdate(doc, update);
      }
    },
    findOneAndUpdate: async (
      query: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
      options?: { upsert?: boolean },
    ) => {
      let doc = docs.find((row) => matchesQuery(row, query));
      if (!doc && options?.upsert) {
        doc = {
          _id: new Types.ObjectId(),
          ...(update.$setOnInsert ?? {}),
          ...(update.$set ?? {}),
        } as SkillRow;
        docs.push(doc);
        return doc;
      }
      if (doc) {
        applyUpdate(doc, update);
      }
      return doc ?? null;
    },
  };
}

describe('MCP stub skills', () => {
  const docs: SkillRow[] = [];

  beforeEach(() => {
    docs.length = 0;
    mongoose.models.Skill = createSkillModel(docs) as unknown as mongoose.Model<ISkillDocument>;
  });

  it('builds a stable kebab-case stub name', () => {
    expect(mcpStubSkillName('Formbricks')).toBe('mcp-formbricks');
    expect(mcpStubSkillName('Data For SEO')).toBe('mcp-data-for-seo');
  });

  it('merges MCP skill ids without duplicates', () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    const merged = mergeMcpSkillIds([a, a.toString(), b]);
    expect(merged.map((id) => id.toString()).sort()).toEqual([a.toString(), b.toString()].sort());
  });

  it('upserts a stub when no curated skill covers the server', async () => {
    await syncMcpSkills({
      formbricks: { chatMenu: true },
      hidden: { chatMenu: false },
      agentOnly: { consumeOnly: true },
    });

    const stubs = docs.filter((doc) => doc.source === 'mcp');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].name).toBe('mcp-formbricks');
    expect(stubs[0].mcpServers).toEqual(['formbricks']);
    expect(stubs[0].disableModelInvocation).toBe(false);
    expect(getMcpSkillIds()).toHaveLength(1);
  });

  it('does not keep a stub when a curated skill already maps the server', async () => {
    docs.push({
      _id: new Types.ObjectId(),
      name: 'umfragen-formbricks',
      source: 'inline',
      mcpServers: ['formbricks'],
    });

    await syncMcpSkills({
      formbricks: { chatMenu: true },
      dataforseo: { chatMenu: true },
    });

    const formbricksStub = docs.find(
      (doc) => doc.source === 'mcp' && doc.sourceMetadata?.serverName === 'formbricks',
    );
    const dataforseoStub = docs.find(
      (doc) => doc.source === 'mcp' && doc.sourceMetadata?.serverName === 'dataforseo',
    );

    expect(formbricksStub).toBeUndefined();
    expect(dataforseoStub?.disableModelInvocation).toBe(false);
    expect(dataforseoStub?.name).toBe('mcp-dataforseo');
  });

  it('deactivates stubs when the server leaves config', async () => {
    await syncMcpSkills({ formbricks: { chatMenu: true } });
    expect(getMcpSkillIds()).toHaveLength(1);

    await syncMcpSkills({});
    const stub = docs.find((doc) => doc.source === 'mcp');
    expect(stub?.disableModelInvocation).toBe(true);
    expect(getMcpSkillIds()).toHaveLength(0);
  });
});
