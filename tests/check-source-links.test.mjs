import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkLink, linksOf } from "../scripts/check-source-links.mjs";

test("checkLink separates open, 404 and unreachable; linksOf keeps only http(s) links", async () => {
  const server = createServer((req, res) => { res.statusCode = req.url === "/gone" ? 404 : 200; res.end("We run Workday HCM"); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await checkLink(`${base}/ok`), { opens: true, status: 200, mentionsWorkday: true });
    assert.equal((await checkLink(`${base}/gone`)).opens, false);
  } finally { server.close(); }
  assert.equal((await checkLink(`${base}/ok`)).opens, false); // server closed
  assert.deepEqual(linksOf({ source: "SEC list", signals: [{ source_url: "https://a.com/x" }, { source_url: "https://a.com/x" }] }), ["https://a.com/x"]);
});
