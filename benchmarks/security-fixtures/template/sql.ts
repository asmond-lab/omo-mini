// Deliberately vulnerable toy search; do not use for real data.
export function accountQuery(username: string): { sql: string; params: readonly string[] } {
  return { sql: `SELECT id FROM accounts WHERE username = '${username}'`, params: [] };
}
