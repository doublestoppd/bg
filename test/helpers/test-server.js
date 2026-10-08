import { resetDatabase } from './test-database.js';
import { createApp } from '../../src/app.js';

// Starts the real application on a random free port against the wiped test
// database. Returns a small client that remembers cookies between requests,
// so a test can log in and then visit protected pages like a browser would.
// appOptions are passed through to createApp (for example trustProxy).
export async function startTestServer(appOptions = {}) {
  const db = await resetDatabase();
  const app = createApp({ db, ...appOptions });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function request(path, { method = 'GET', form, headers: extraHeaders = {} } = {}) {
    const headers = { cookie, ...extraHeaders };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const response = await fetch(baseUrl + path, { method, headers, body, redirect: 'manual' });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      cookie = setCookie.split(';')[0];
    }
    const text = await response.text();
    return { status: response.status, text, location: response.headers.get('location'), setCookie };
  }

  // Fetches a page and pulls the CSRF token out of its form.
  async function csrfTokenFrom(path) {
    const page = await request(path);
    const match = page.text.match(/name="_csrf" value="([^"]+)"/);
    if (!match) throw new Error(`No CSRF token found on ${path}`);
    return match[1];
  }

  // Registers a player and leaves the client logged in. Returns the user id.
  async function registerAndLogIn(username) {
    const token = await csrfTokenFrom('/register');
    await request('/register', {
      method: 'POST',
      form: { _csrf: token, username, password: 'correct horse' },
    });
    const { rows } = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    return rows[0].id;
  }

  async function logOut() {
    const token = await csrfTokenFrom('/');
    await request('/logout', { method: 'POST', form: { _csrf: token } });
  }

  function close() {
    return new Promise((resolve) => server.close(resolve));
  }

  return { db, request, csrfTokenFrom, registerAndLogIn, logOut, close, cookieHeader: () => cookie };
}
