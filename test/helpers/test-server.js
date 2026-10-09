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
    const token = csrfTokenIn(page.text);
    if (!token) throw new Error(`No CSRF token found on ${path}`);
    return token;
  }

  // The buy form for a listing on a shop page, by its stock id: its CSRF
  // token, request id and shown price. Null when the page has no such form.
  async function listingForm(shopId, listingId) {
    const page = await request(`/shops/${shopId}`);
    const form = page.text.match(new RegExp(`name="request_id" value="([^"]+)">\\s*<input type="hidden" name="listing" value="${listingId}">\\s*<input type="hidden" name="shown_price" value="(\\d+)"`));
    if (!form) return null;
    return { csrf: csrfTokenIn(page.text), requestId: form[1], shownPrice: form[2] };
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

  return { db, request, csrfTokenFrom, listingForm, registerAndLogIn, logOut, close, cookieHeader: () => cookie };
}

// Pulls the CSRF token out of a rendered page, or returns null.
export function csrfTokenIn(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : null;
}
