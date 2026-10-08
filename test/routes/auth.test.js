import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';
import { createApp } from '../../src/app.js';

test('a visitor can register, is logged in, and can log out', async () => {
  const server = await startTestServer();
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

    await server.logOut();
    const afterLogout = await server.request('/');
    assert.doesNotMatch(afterLogout.text, /Hello, <strong>wobble/);
  } finally {
    await server.close();
  }
});

test('login rejects a wrong password and accepts the right one', async () => {
  const server = await startTestServer();
  try {
    await server.registerAndLogIn('wobble');
    await server.logOut();

    const token = await server.csrfTokenFrom('/login');
    const bad = await server.request('/login', {
      method: 'POST',
      form: { _csrf: token, username: 'wobble', password: 'nope nope nope' },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /do not match/);

    const good = await server.request('/login', {
      method: 'POST',
      form: { _csrf: token, username: 'WOBBLE', password: 'correct horse' },
    });
    assert.equal(good.status, 302);
    assert.match((await server.request('/')).text, /Hello, <strong>wobble/);
  } finally {
    await server.close();
  }
});

test('a login survives a restart of the application', async () => {
  const server = await startTestServer();
  try {
    await server.registerAndLogIn('wobble');
    // A second app object over the same database stands in for a restarted
    // server process; the browser still holds the same cookie.
    const second = createApp({ db: server.db }).listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${second.address().port}/`, { headers: { cookie: server.cookieHeader() } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Hello, <strong>wobble/);
    } finally {
      second.close();
    }
  } finally {
    await server.close();
  }
});

test('a form without a CSRF token is refused', async () => {
  const server = await startTestServer();
  try {
    await server.request('/register'); // establishes a session
    const submit = await server.request('/register', {
      method: 'POST',
      form: { username: 'wobble', password: 'correct horse' },
    });
    assert.equal(submit.status, 403);
  } finally {
    await server.close();
  }
});

test('repeated failed logins from one address are rate limited', async () => {
  const server = await startTestServer();
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
    const { rows } = await server.db.query("SELECT count FROM request_counters WHERE scope = 'login:ip'");
    assert.equal(rows[0].count, 11, 'the counter lives in the database');
  } finally {
    await server.close();
  }
});

test('rate limits persist across an application restart', async () => {
  const server = await startTestServer();
  try {
    const token = await server.csrfTokenFrom('/login');
    const attempt = () => server.request('/login', { method: 'POST', form: { _csrf: token, username: 'nobody', password: 'guess guess guess' } });
    for (let i = 0; i < 10; i++) await attempt();
    // A fresh app over the same database, as after a restart, still refuses.
    const second = createApp({ db: server.db }).listen(0);
    try {
      const port = second.address().port;
      const page = await fetch(`http://127.0.0.1:${port}/login`);
      const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
      const cookie = page.headers.get('set-cookie').split(';')[0];
      const blocked = await fetch(`http://127.0.0.1:${port}/login`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, username: 'nobody', password: 'guess guess guess' }).toString(),
      });
      assert.equal(blocked.status, 429);
    } finally {
      second.close();
    }
  } finally {
    await server.close();
  }
});

test('behind a trusted proxy, rate limiting uses the forwarded client address', async () => {
  const server = await startTestServer({ trustProxy: 1 });
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
    await server.close();
  }
});

test('secure cookies are only sent when the proxy reports HTTPS', async () => {
  const trusting = await startTestServer({ trustProxy: 1, secureCookies: true });
  try {
    const plain = await trusting.request('/login');
    assert.equal(plain.setCookie, null, 'no cookie over plain HTTP');
    const forwarded = await trusting.request('/login', { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(forwarded.setCookie, /^bg\.sid=.*Secure/);
  } finally {
    await trusting.close();
  }
  const untrusting = await startTestServer({ trustProxy: false, secureCookies: true });
  try {
    const ignored = await untrusting.request('/login', { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(ignored.setCookie, null, 'the header is ignored when the proxy is not trusted');
  } finally {
    await untrusting.close();
  }
});
