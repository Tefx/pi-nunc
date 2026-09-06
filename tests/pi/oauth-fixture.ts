/** Fictional native OAuth record only. Never reads an account, environment or credential store. */
export function oauthFixture(expires = Date.now() + 86400000, revision = "initial") {
  const access = [Buffer.from('{"alg":"none"}').toString("base64url"), Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "nunc-fixture-account" }, fixture: revision })).toString("base64url"), "fixture-signature"].join(".");
  return { type: "oauth" as const, access, refresh: `fictional-refresh-${revision}`, expires, accountId: "nunc-fixture-account" };
}
