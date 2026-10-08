import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';

test('the front page renders with the site name and menu', async () => {
  const server = startTestServer();
  try {
    const page = await server.request('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Blobgarden/);
    assert.match(page.text, /href="\/register"/);
  } finally {
    server.close();
  }
});

test('unknown pages return a friendly 404', async () => {
  const server = startTestServer();
  try {
    const page = await server.request('/nowhere');
    assert.equal(page.status, 404);
    assert.match(page.text, /Page not found/);
  } finally {
    server.close();
  }
});
