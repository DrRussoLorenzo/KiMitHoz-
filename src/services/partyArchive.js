const { Party } = require('../models');

const ARCHIVE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Archiválja a lejárati időnél régebbi, még aktív eseményeket. */
async function archiveExpiredParties(aktualisIdo = new Date()) {
  const archivHatar = new Date(aktualisIdo.getTime() - ARCHIVE_DELAY_MS);
  const eredmeny = await Party.updateMany(
    { date: { $lte: archivHatar }, isArchived: { $ne: true } },
    { $set: { isArchived: true, archivedAt: aktualisIdo } }
  );
  return eredmeny.modifiedCount;
}

module.exports = { ARCHIVE_DELAY_MS, archiveExpiredParties };
