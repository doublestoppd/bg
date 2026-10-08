// Optional enhancement for shop pages: every so often, ask the server for
// the current remaining quantities and update the numbers on the page, so
// a player watching the shelves sees things sell out without reloading.
// If a restock has replaced the listings, a notice invites a reload.
//
// Shopping works exactly the same without this file: the forms are plain
// HTML and the server decides everything. The refresh is deliberately
// slow (one request a minute, only while the tab is visible) and it is
// subject to the same rate limits as loading the page.
(function () {
  var shelves = document.querySelector('.shelves');
  if (!shelves || !window.fetch) return;

  var INTERVAL_MS = 60 * 1000;
  var shopId = shelves.getAttribute('data-shop');
  var restockId = shelves.getAttribute('data-restock');
  var changedNotice = document.querySelector('.shelves-changed');

  function refresh() {
    if (document.hidden) return;
    fetch('/shops/' + encodeURIComponent(shopId) + '/stock.json', { credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (stock) {
        if (!stock) return;
        if (String(stock.restockId) !== String(restockId) || stock.paused) {
          changedNotice.hidden = false;
          return;
        }
        stock.listings.forEach(function (listing) {
          var box = shelves.querySelector('[data-listing="' + listing.id + '"]');
          if (!box) return;
          var count = box.querySelector('.remaining');
          if (listing.remaining === 0 && !box.classList.contains('sold-out')) {
            box.classList.add('sold-out');
            var label = box.querySelector('.stock-count');
            if (label) { label.textContent = 'Sold out'; label.classList.add('sold-out-label'); }
            var form = box.querySelector('.buy-form');
            if (form) form.remove();
          } else if (count) {
            count.textContent = listing.remaining;
            var input = box.querySelector('input[name="quantity"]');
            if (input && Number(input.max) > listing.remaining) input.max = listing.remaining;
          }
        });
      })
      .catch(function () { /* a failed refresh is simply skipped */ });
  }

  setInterval(refresh, INTERVAL_MS);
})();
