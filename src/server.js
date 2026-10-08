import config from './config.js';
import { openDatabase } from './db/connection.js';
import { createApp } from './app.js';

const db = openDatabase(config.databasePath);
const app = createApp({ db });

app.listen(config.port, () => {
  console.log(`Game running at http://localhost:${config.port}`);
});
