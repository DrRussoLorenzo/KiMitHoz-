const request = require('supertest');
const { app } = require('../../server');

/** Létrehoz egy sikeres választ elváró GET-kérést a tesztszerverhez. */
function getRequest(utvonal) {
  return request(app).get(utvonal).set('Accept', '*/*').expect(200);
}

module.exports = getRequest;
