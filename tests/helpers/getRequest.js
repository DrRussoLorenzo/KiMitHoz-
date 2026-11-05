const request = require('supertest');
const { app } = require('../../server');

function getRequest(path) {
  return request(app)
    .get(path)
    .set('Accept', '*/*')
    .expect(200);
}

module.exports = getRequest;