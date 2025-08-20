const { logger } = require('@librechat/data-schemas');
const { Conversation, Message, File } = require('~/db/models');

/**
 * Ermittelt verwaiste File-Dokumente (keine Referenz in Conversation.files oder Message.files)
 */
async function findOrphanFiles() {
  const files = await File.find({}, 'file_id embedded').lean();
  if (!files.length) return [];
  const fileIdSet = new Set(files.map((f) => f.file_id));

  const convRefs = await Conversation.find({ files: { $exists: true, $ne: [] } }, 'files').lean();
  for (const c of convRefs) {
    if (Array.isArray(c.files)) {
      for (const fid of c.files) fileIdSet.delete(fid);
    }
  }

  const msgRefs = await Message.find({ files: { $exists: true, $ne: [] } }, 'files').lean();
  for (const m of msgRefs) {
    if (Array.isArray(m.files)) {
      for (const f of m.files) {
        if (!f) continue;
        if (typeof f === 'string') fileIdSet.delete(f);
        else if (f.file_id) fileIdSet.delete(f.file_id);
        else if (f.fileId) fileIdSet.delete(f.fileId);
      }
    }
  }

  return Array.from(fileIdSet);
}

async function cleanupOrphanFiles({ app, dryRun = false }) {
  try {
    const orphanIds = await findOrphanFiles();
    if (!orphanIds.length) {
      logger.debug('[OrphanFiles] Keine verwaisten Dateien gefunden');
      return { deleted: 0, orphanIds };
    }
    if (dryRun) {
      logger.info(`[OrphanFiles] DryRun: ${orphanIds.length} verwaiste Dateien`);
      return { deleted: 0, orphanIds };
    }
    const { deleteFiles } = require('~/models/File');
    const result = await deleteFiles(orphanIds);
    logger.info(`[OrphanFiles] Gelöscht: ${result.deletedCount}/${orphanIds.length}`);
    return { deleted: result.deletedCount, orphanIds };
  } catch (err) {
    logger.error('[OrphanFiles] Fehler beim Cleanup', err);
    return { error: err.message };
  }
}

function scheduleOrphanFileCleanup({ app, intervalMs }) {
  const run = () => {
    cleanupOrphanFiles({ app }).catch((e) => logger.error('[OrphanFiles] Zyklus Fehler', e));
  };
  setInterval(run, intervalMs).unref();
  run();
}

module.exports = { findOrphanFiles, cleanupOrphanFiles, scheduleOrphanFileCleanup };
