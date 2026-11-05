const { Party } = require('../models');

const ARCHIVE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

async function archiveExpiredParties(now = new Date()) {
  const cutoff = new Date(now.getTime() - ARCHIVE_DELAY_MS);
  const result = await Party.updateMany(
    { date: { $lte: cutoff }, isArchived: { $ne: true } },
    { $set: { isArchived: true, archivedAt: now } }
  );
  return result.modifiedCount;
}

module.exports = { ARCHIVE_DELAY_MS, archiveExpiredParties };