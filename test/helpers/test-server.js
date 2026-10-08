import { openDatabase } from '../../src/db/connection.js';
import { createApp } from '../../src/app.js';

// Starts the real application on a random free port with an in-memory
// database. Returns a small client that remembers cookies between requests,
// so a test can log in and then visit protected pages like a browser would.
// appOptions are passed through to createApp (for example trustProxy).
export function startTestServer(appOptions = {}) {
  const db = openDatabase(':memory:');
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

  function close() {
    server.close();
    db.close();
  }

  return { db, request, csrfTokenFrom, close };
}
