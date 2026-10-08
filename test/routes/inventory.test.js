import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';
import { countOwned } from '../../src/game/inventory.js';

async function adopt(server, name) {
  const token = await server.csrfTokenFrom('/pets/adopt');
  const submit = await server.request('/pets/adopt', {
    method: 'POST',
    form: { _csrf: token, name, species: 'wompus' },
  });
  return Number(submit.location.match(/\/pets\/(\d+)/)[1]);
}

test('guests are sent to the login page', async () => {
  const server = await startTestServer();
  try {
    const page = await server.request('/inventory');
    assert.equal(page.status, 302);
    assert.equal(page.location, '/login');
  } finally {
    await server.close();
  }
});

test('new players see their welcome items', async () => {
  const server = await startTestServer();
  try {
    await server.registerAndLogIn('wobble');
    const page = await server.request('/inventory');
    assert.equal(page.status, 200);
    assert.match(page.text, /Soggy Biscuit/);
    assert.match(page.text, /&times;3/);
    assert.doesNotMatch(page.text, /action="\/inventory\/feed"/, 'no feed form without a pet');
  } finally {
    await server.close();
  }
});

test('feeding from the inventory page updates the pet and redirects', async () => {
  const server = await startTestServer();
  try {
    await server.registerAndLogIn('wobble');
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
    assert.doesNotMatch((await server.request('/inventory')).text, /Pebbles ate/, 'the message shows once');
    assert.match((await server.request(`/pets/${petId}`)).text, /75\/100/);
  } finally {
    await server.close();
  }
});

test("feeding another player's pet is refused and keeps the item", async () => {
  const server = await startTestServer();
  try {
    await server.registerAndLogIn('wobble');
    const victimPet = await adopt(server, 'Private');
    await server.logOut();
    const nosyId = await server.registerAndLogIn('nosy');
    const token = await server.csrfTokenFrom('/inventory');
    const submit = await server.request('/inventory/feed', {
      method: 'POST',
      form: { _csrf: token, item: 'soggy-biscuit', pet: victimPet },
    });
    assert.equal(submit.status, 400);
    assert.match(submit.text, /not yours to feed/);
    assert.equal(await countOwned(server.db, nosyId, 'soggy-biscuit'), 3);
  } finally {
    await server.close();
  }
});

test('two simultaneous submissions for the last item feed the pet only once', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const petId = await adopt(server, 'Pebbles');
    assert.equal(await countOwned(server.db, userId, 'humming-turnip'), 1);
    const token = await server.csrfTokenFrom('/inventory');
    const feed = () => server.request('/inventory/feed', {
      method: 'POST',
      form: { _csrf: token, item: 'humming-turnip', pet: petId },
    });
    const results = await Promise.all([feed(), feed()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [302, 400]);
    assert.equal(await countOwned(server.db, userId, 'humming-turnip'), 0);
    const { rows } = await server.db.query('SELECT hunger FROM pets WHERE id = $1', [petId]);
    assert.equal(rows[0].hunger, 85, 'one turnip: 60 + 25');
  } finally {
    await server.close();
  }
});

test('a limited-time item shows as no longer obtainable but still has a feed form', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    await adopt(server, 'Pebbles');
    await server.db.query('INSERT INTO inventory (user_id, item_id, quantity) VALUES ($1, $2, 1)', [userId, 'jubilee-crumpet']);
    const page = await server.request('/inventory');
    assert.match(page.text, /Jubilee Crumpet/);
    assert.match(page.text, /no longer obtainable/);
    assert.match(page.text, /name="item" value="jubilee-crumpet"/, 'still usable');
  } finally {
    await server.close();
  }
});
