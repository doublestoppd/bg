import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';

test('a visitor can register, is logged in, and can log out', async () => {
  const server = startTestServer();
  try {
    const token = await server.csrfTokenFrom('/register');
    const submit = await server.request('/register', {
      method: 'POST',
      form: { _csrf: token, username: 'wobble', password: 'correct horse' },
    });
    assert.equal(submit.status, 302);
    assert.equal(submit.location, '/');

    const home = await server.request('/');
    assert.match(home.text, /Hello, <strong>wobble<\/strong>/);
    assert.match(home.text, /action="\/logout"/);

    const logoutToken = await server.csrfTokenFrom('/');
    const logout = await server.request('/logout', { method: 'POST', form: { _csrf: logoutToken } });
    assert.equal(logout.status, 302);

    const afterLogout = await server.request('/');
    assert.doesNotMatch(afterLogout.text, /Hello, <strong>wobble/);
  } finally {
    server.close();
  }
});

test('login rejects a wrong password and accepts the right one', async () => {
  const server = startTestServer();
  try {
    let token = await server.csrfTokenFrom('/register');
    await server.request('/register', {
      method: 'POST',
      form: { _csrf: token, username: 'wobble', password: 'correct horse' },
    });
    token = await server.csrfTokenFrom('/');
    await server.request('/logout', { method: 'POST', form: { _csrf: token } });

    token = await server.csrfTokenFrom('/login');
    const bad = await server.request('/login', {
      method: 'POST',
      form: { _csrf: token, username: 'wobble', password: 'nope nope nope' },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /do not match/);

    const good = await server.request('/login', {
      method: 'POST',
      form: { _csrf: token, username: 'wobble', password: 'correct horse' },
    });
    assert.equal(good.status, 302);
  } finally {
    server.close();
  }
});

test('a form without a CSRF token is refused', async () => {
  const server = startTestServer();
  try {
    await server.request('/register'); // establishes a session
    const submit = await server.request('/register', {
      method: 'POST',
      form: { username: 'wobble', password: 'correct horse' },
    });
    assert.equal(submit.status, 403);
  } finally {
    server.close();
  }
});
