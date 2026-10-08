import config from './config.js';
import { openDatabase } from './db/connection.js';
import { createApp } from './app.js';
import { syncItemCatalog } from './game/items.js';

const db = openDatabase(config.databasePath);
syncItemCatalog(db); // keep the items table in step with src/game/items.js
const app = createApp({ db });

app.listen(config.port, () => {
  console.log(`Game running at http://localhost:${config.port}`);
});
