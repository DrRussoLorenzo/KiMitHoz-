const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

async function connectTestDatabase() {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}

async function clearTestDatabase() {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({}))
  );
}

async function disconnectTestDatabase() {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = undefined;
  }
}

module.exports = { connectTestDatabase, clearTestDatabase, disconnectTestDatabase };