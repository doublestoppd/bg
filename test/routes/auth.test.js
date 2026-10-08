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

test('repeated failed logins from one address are rate limited', async () => {
  const server = startTestServer();
  try {
    const token = await server.csrfTokenFrom('/login');
    let last;
    for (let attempt = 1; attempt <= 11; attempt++) {
      last = await server.request('/login', {
        method: 'POST',
        form: { _csrf: token, username: 'nobody', password: 'guess guess guess' },
      });
      if (attempt <= 10) assert.equal(last.status, 400, `attempt ${attempt} should still reach the form`);
    }
    assert.equal(last.status, 429);
    assert.match(last.text, /Too many attempts/);
  } finally {
    server.close();
  }
});

test('behind a trusted proxy, rate limiting uses the forwarded client address', async () => {
  const server = startTestServer({ trustProxy: 1 });
  try {
    const token = await server.csrfTokenFrom('/login');
    const attempt = (ip) => server.request('/login', {
      method: 'POST',
      form: { _csrf: token, username: 'nobody', password: 'guess guess guess' },
      headers: { 'x-forwarded-for': ip },
    });
    for (let i = 0; i < 10; i++) await attempt('203.0.113.5');
    assert.equal((await attempt('203.0.113.5')).status, 429);
    assert.equal((await attempt('203.0.113.6')).status, 400, 'a different client is not blocked');
  } finally {
    server.close();
  }
});

test('secure cookies are only sent when the proxy reports HTTPS', async () => {
  // In production the session cookie is marked secure. Behind a reverse
  // proxy the app only knows the request was HTTPS if it trusts the
  // X-Forwarded-Proto header, which is what TRUST_PROXY turns on.
  const trusting = startTestServer({ trustProxy: 1, secureCookies: true });
  const untrusting = startTestServer({ trustProxy: false, secureCookies: true });
  try {
    const plain = await trusting.request('/login');
    assert.equal(plain.setCookie, null, 'no cookie over plain HTTP');

    const forwarded = await trusting.request('/login', { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(forwarded.setCookie, /^bg\.sid=.*Secure/);

    const ignored = await untrusting.request('/login', { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(ignored.setCookie, null, 'the header is ignored when the proxy is not trusted');
  } finally {
    trusting.close();
    untrusting.close();
  }
});
