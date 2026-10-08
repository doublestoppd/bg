import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';
import { countOwned } from '../../src/game/inventory.js';

async function registerAndLogIn(server, username) {
  const token = await server.csrfTokenFrom('/register');
  await server.request('/register', {
    method: 'POST',
    form: { _csrf: token, username, password: 'correct horse' },
  });
}

async function adopt(server, name) {
  const token = await server.csrfTokenFrom('/pets/adopt');
  const submit = await server.request('/pets/adopt', {
    method: 'POST',
    form: { _csrf: token, name, species: 'wompus' },
  });
  return Number(submit.location.match(/\/pets\/(\d+)/)[1]);
}

test('guests are sent to the login page', async () => {
  const server = startTestServer();
  try {
    const page = await server.request('/inventory');
    assert.equal(page.status, 302);
    assert.equal(page.location, '/login');
  } finally {
    server.close();
  }
});

test('new players see their welcome items', async () => {
  const server = startTestServer();
  try {
    await registerAndLogIn(server, 'wobble');
    const page = await server.request('/inventory');
    assert.equal(page.status, 200);
    assert.match(page.text, /Soggy Biscuit/);
    assert.match(page.text, /&times;3/);
    assert.doesNotMatch(page.text, /action="\/inventory\/feed"/, 'no feed form without a pet');
  } finally {
    server.close();
  }
});

test('feeding from the inventory page updates the pet and redirects', async () => {
  const server = startTestServer();
  try {
    await registerAndLogIn(server, 'wobble');
    const petId = await adopt(server, 'Pebbles');
    const token = await server.csrfTokenFrom('/inventory');

    const submit = await server.request('/inventory/feed', {
      method: 'POST',
      form: { _csrf: token, item: 'soggy-biscuit', pet: petId },
    });
    assert.equal(submit.status, 302);
    assert.equal(submit.location, '/inventory');

    const page = await server.request('/inventory');
    assert.match(page.text, /Pebbles ate the Soggy Biscuit\. Hunger 60 to 75\./);
    assert.match(page.text, /&times;2/);

    const again = await server.request('/inventory');
    assert.doesNotMatch(again.text, /Pebbles ate/, 'the message shows once');

    const petPage = await server.request(`/pets/${petId}`);
    assert.match(petPage.text, /75\/100/);
  } finally {
    server.close();
  }
});

test("feeding another player's pet is refused and keeps the item", async () => {
  const server = startTestServer();
  try {
    await registerAndLogIn(server, 'wobble');
    const victimPet = await adopt(server, 'Private');
    let token = await server.csrfTokenFrom('/');
    await server.request('/logout', { method: 'POST', form: { _csrf: token } });

    await registerAndLogIn(server, 'nosy');
    token = await server.csrfTokenFrom('/inventory');
    const submit = await server.request('/inventory/feed', {
      method: 'POST',
      form: { _csrf: token, item: 'soggy-biscuit', pet: victimPet },
    });
    assert.equal(submit.status, 400);
    assert.match(submit.text, /not yours to feed/);
    const nosy = server.db.prepare('SELECT id FROM users WHERE username = ?').get('nosy');
    assert.equal(countOwned(server.db, nosy.id, 'soggy-biscuit'), 3);
  } finally {
    server.close();
  }
});

test('two simultaneous submissions for the last item feed the pet only once', async () => {
  const server = startTestServer();
  try {
    await registerAndLogIn(server, 'wobble');
    const petId = await adopt(server, 'Pebbles');
    const user = server.db.prepare('SELECT id FROM users WHERE username = ?').get('wobble');
    // Leave exactly one turnip (new players get one).
    assert.equal(countOwned(server.db, user.id, 'humming-turnip'), 1);
    const token = await server.csrfTokenFrom('/inventory');
    const feed = () => server.request('/inventory/feed', {
      method: 'POST',
      form: { _csrf: token, item: 'humming-turnip', pet: petId },
    });

    const results = await Promise.all([feed(), feed()]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [302, 400]);
    assert.equal(countOwned(server.db, user.id, 'humming-turnip'), 0);
    const pet = server.db.prepare('SELECT hunger FROM pets WHERE id = ?').get(petId);
    assert.equal(pet.hunger, 85, 'one turnip: 60 + 25');
  } finally {
    server.close();
  }
});

test('a limited-time item shows as no longer obtainable but still has a feed form', async () => {
  const server = startTestServer();
  try {
    await registerAndLogIn(server, 'wobble');
    await adopt(server, 'Pebbles');
    const user = server.db.prepare('SELECT id FROM users WHERE username = ?').get('wobble');
    server.db.prepare('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, 1)').run(user.id, 'jubilee-crumpet');

    const page = await server.request('/inventory');
    assert.match(page.text, /Jubilee Crumpet/);
    assert.match(page.text, /no longer obtainable/);
    assert.match(page.text, /name="item" value="jubilee-crumpet"/, 'still usable');
  } finally {
    server.close();
  }
});
