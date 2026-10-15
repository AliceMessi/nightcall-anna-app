"use strict";
const { getUser, planLimit } = require("./user");

function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

/**
 * POST /checkout
 * Body: { items: [{ sku, price, qty }] }
 */
async function handler(req, res) {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) {
    return res.status(400).json({ error: "cart is empty" });
  }
  const user = getUser(req.session);
  if (items.length > planLimit(user).maxItems) {
    return res.status(403).json({ error: "too many items for your plan" });
  }
  return res.status(200).json({ user: user.id, total: total(items) });
}

module.exports = { handler, total };
