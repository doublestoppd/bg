import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';

async function registerAndLogIn(server, username) {
  const token = await server.csrfTokenFrom('/register');
  await server.request('/register', {
    method: 'POST',
    form: { _csrf: token, username, password: 'correct horse' },
  });
}

test('guests are sent to the login page', async () => {
  const server = startTestServer();
  try {
    const page = await server.request('/pets');
    assert.equal(page.status, 302);
    assert.equal(page.location, '/login');
  } finally {
    server.close();
  }
});

test('a player can adopt a pet and see it on its page and in the list', async () => {
  const server = startTestServer();
  try {
    await registerAndLogIn(server, 'wobble');

    const token = await server.csrfTokenFrom('/pets/adopt');
    const submit = await server.request('/pets/adopt', {
      method: 'POST',
      form: { _csrf: token, name: 'Sir Wobble', species: 'wompus' },
    });
    assert.equal(submit.status, 302);
    assert.match(submit.location, /^\/pets\/\d+\?adopted=1$/);

    const petPage = await server.request(submit.location);
    assert.equal(petPage.status, 200);
    assert.match(petPage.text, /has come to live with you/);
    assert.match(petPage.text, /Sir Wobble/);

    const list = await server.request('/pets');
    assert.match(list.text, /Sir Wobble/);
  } finally {
    server.close();
  }
});

test('a rule violation re-shows the adopt form with the message', async () => {
  const server = startTestServer();
  try {
    await registerAndLogIn(server, 'wobble');
    const token = await server.csrfTokenFrom('/pets/adopt');
    const submit = await server.request('/pets/adopt', {
      method: 'POST',
      form: { _csrf: token, name: 'X', species: 'wompus' },
    });
    assert.equal(submit.status, 400);
    assert.match(submit.text, /Pet names must be/);
  } finally {
    server.close();
  }
});

test("another player's pet page is a 404", async () => {
  const server = startTestServer();
  try {
    await registerAndLogIn(server, 'wobble');
    let token = await server.csrfTokenFrom('/pets/adopt');
    const submit = await server.request('/pets/adopt', {
      method: 'POST',
      form: { _csrf: token, name: 'Private', species: 'gloop' },
    });
    const petPath = submit.location.split('?')[0];

    token = await server.csrfTokenFrom('/');
    await server.request('/logout', { method: 'POST', form: { _csrf: token } });
    await registerAndLogIn(server, 'nosy');

    const page = await server.request(petPath);
    assert.equal(page.status, 404);
  } finally {
    server.close();
  }
});
