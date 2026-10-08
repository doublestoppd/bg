# Artwork

Drop image files in this folder and point the game at them. Nothing here is
required: wherever an image is missing, the page shows a labelled placeholder
box instead, so the layout can be designed before the art exists.

| What                 | Where to set the path                         | Suggested file          |
|----------------------|-----------------------------------------------|-------------------------|
| Site logo            | `logoImage` in `src/site.js`                  | `logo.png`              |
| Navigation buttons   | `image` on an entry in `src/navigation.js`    | `nav/pets.png`          |
| Species portraits    | `image` on a species in `src/game/species.js` | `species/<slug>.png`    |
| Item icons           | `image` on an item in `src/game/items.js`     | `items/<id>.png`        |
| Shopkeepers          | `image` on a shop in `src/game/shops.js`      | `shops/<id>.png`        |

Paths are URL paths, so a file at `src/public/images/logo.png` is referenced
as `/images/logo.png`.

Templates render pictures with the `partials/picture.ejs` partial, which
handles the placeholder fallback. Use it rather than writing `<img>` tags by
hand so the fallback behaviour stays consistent.
