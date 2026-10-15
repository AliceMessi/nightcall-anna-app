"use strict";
// Highlights the search term inside product titles.

function highlight(title, query) {
  const re = new RegExp(query, "gi");
  return title.replace(re, (match) => `<mark>${match}</mark>`);
}

module.exports = { highlight };
