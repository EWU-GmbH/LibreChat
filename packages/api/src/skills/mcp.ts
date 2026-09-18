import mongoose from 'mongoose';
import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { ISkill, ISkillDocument } from '@librechat/data-schemas';
import { isChatSelectableMcpServer } from '~/mcp/chatServers';
import type { ChatSelectableMcpConfig } from '~/mcp/chatServers';

const MCP_SKILL_AUTHOR_ID = new Types.ObjectId('de9100000000000000000000');
const DESCRIPTION_MAX = 1024;

let cachedMcpSkillIds: Types.ObjectId[] = [];

export function getMcpSkillIds(): Types.ObjectId[] {
  return cachedMcpSkillIds;
}

export function mergeMcpSkillIds(ids: Array<string | Types.ObjectId>): Types.ObjectId[] {
  const seen = new Set<string>();
  const merged: Types.ObjectId[] = [];
  for (const id of [...ids, ...cachedMcpSkillIds]) {
    const oid = typeof id === 'string' ? new Types.ObjectId(id) : id;
    const key = oid.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(oid);
  }
  return merged;
}

export function mcpStubSkillName(serverName: string): string {
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `mcp-${slug || 'server'}`;
}

function skillModel(): mongoose.Model<ISkillDocument> | null {
  return (mongoose.models.Skill as mongoose.Model<ISkillDocument> | undefined) ?? null;
}

function truncateDescription(text: string): string {
  if (text.length <= DESCRIPTION_MAX) {
    return text;
  }
  return `${text.slice(0, DESCRIPTION_MAX - 1)}…`;
}

export async function syncMcpSkills(
  mcpConfig: Record<string, ChatSelectableMcpConfig | undefined> | undefined,
): Promise<Types.ObjectId[]> {
  const Skill = skillModel();
  if (!Skill) {
    cachedMcpSkillIds = [];
    return cachedMcpSkillIds;
  }

  const selectable = Object.entries(mcpConfig ?? {}).filter(([, config]) =>
    isChatSelectableMcpServer(config),
  );
  const activeNames = new Set(selectable.map(([name]) => name));

  try {
    const curated = await Skill.find({
      source: { $ne: 'mcp' },
      mcpServers: { $exists: true, $ne: [] },
    })
      .select('mcpServers')
      .lean();

    const covered = new Set<string>();
    for (const skill of curated) {
      for (const serverName of skill.mcpServers ?? []) {
        covered.add(serverName);
      }
    }

    for (const [serverName, config] of selectable) {
      if (covered.has(serverName)) {
        await Skill.updateMany(
          { source: 'mcp', 'sourceMetadata.serverName': serverName },
          { $set: { disableModelInvocation: true, userInvocable: false } },
        );
        continue;
      }

      const name = mcpStubSkillName(serverName);
      const instructions =
        typeof (config as { serverInstructions?: unknown })?.serverInstructions === 'string'
          ? String((config as { serverInstructions?: string }).serverInstructions)
          : '';
      const description = truncateDescription(
        instructions.trim() || `Use the ${serverName} MCP when the task needs that integration.`,
      );
      const frontmatter = {
        name,
        description,
        'mcp-servers': [serverName],
        'user-invocable': true,
      };
      const body = `---
name: ${name}
description: ${description}
mcp-servers:
  - ${serverName}
user-invocable: true
---

Enable the \`${serverName}\` MCP in chat before calling its tools.
`;

      await Skill.findOneAndUpdate(
        { source: 'mcp', 'sourceMetadata.serverName': serverName },
        {
          $set: {
            name,
            displayTitle: serverName,
            description,
            body,
            frontmatter,
            mcpServers: [serverName],
            disableModelInvocation: false,
            userInvocable: true,
            alwaysApply: false,
            author: MCP_SKILL_AUTHOR_ID,
            authorName: 'MCP',
            category: 'mcp',
            source: 'mcp',
            sourceMetadata: { serverName },
            fileCount: 0,
          },
          $setOnInsert: {
            version: 1,
          },
        },
        { upsert: true },
      );
    }

    await Skill.updateMany(
      {
        source: 'mcp',
        'sourceMetadata.serverName': { $nin: [...activeNames] },
      },
      { $set: { disableModelInvocation: true, userInvocable: false } },
    );

    const activeStubs = await Skill.find({
      source: 'mcp',
      disableModelInvocation: { $ne: true },
    })
      .select('_id')
      .lean();

    cachedMcpSkillIds = activeStubs.map((row) => row._id as Types.ObjectId);
  } catch (error) {
    logger.warn('[MCP Skills] Failed to sync stub skills:', error);
  }

  return cachedMcpSkillIds;
}

export type McpSkillDoc = Pick<ISkill, 'name' | 'description'> & { _id: Types.ObjectId };

export async function listActiveMcpStubSkills(): Promise<McpSkillDoc[]> {
  const Skill = skillModel();
  if (!Skill) {
    return [];
  }
  const rows = await Skill.find({
    source: 'mcp',
    disableModelInvocation: { $ne: true },
  })
    .select('name description')
    .lean();
  return rows as unknown as McpSkillDoc[];
}
