"use strict";
// In-memory user store for the checkout demo service.

const users = new Map([
  ["u_1001", { id: "u_1001", name: "Ada", email: "ada@example.com", plan: "pro" }],
  ["u_1002", { id: "u_1002", name: "Linus", email: "linus@example.com", plan: "free" }],
]);

const PLAN_LIMITS = {
  free: { maxItems: 3 },
  pro: { maxItems: 50 },
};

function planLimit(user) {
  return PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
}

function displayName(user) {
  return user.name || user.email;
}

function isActive(user) {
  return user.plan !== "suspended";
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function findByEmail(email) {
  const wanted = normalizeEmail(email);
  for (const user of users.values()) {
    if (user.email === wanted) return user;
  }
  return null;
}

/**
 * Returns the signed-in user for a session.
 */
function getUser(session) {
  const user = users.get(session.user.id);
  if (!user) throw new Error("unknown user");
  return user;
}

module.exports = { getUser, findByEmail, planLimit, displayName, isActive };
