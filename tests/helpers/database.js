const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let tesztMongoSzerver;

/** Elindítja a memóriában futó MongoDB-tesztadatbázist. */
async function connectTestDatabase() {
  tesztMongoSzerver = await MongoMemoryServer.create();
  await mongoose.connect(tesztMongoSzerver.getUri());
}

/** Kiüríti az adatbázis gyűjteményeit a tesztesetek között. */
async function clearTestDatabase() {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((gyujtemeny) => gyujtemeny.deleteMany({}))
  );
}

/** Lezárja a kapcsolatot és leállítja a memóriabeli adatbázist. */
async function disconnectTestDatabase() {
  await mongoose.disconnect();
  if (tesztMongoSzerver) {
    await tesztMongoSzerver.stop();
    tesztMongoSzerver = undefined;
  }
}

module.exports = { connectTestDatabase, clearTestDatabase, disconnectTestDatabase };
