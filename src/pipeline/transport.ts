// Workday collection uses Node's standard HTTPS client. Other providers keep fetch.
// No browser impersonation, cookie transfer, or challenge-solving behavior is added.
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

function isWorkday(url: URL) {
  return url.protocol === "https:" && /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/i.test(url.hostname);
}

async function workdayRequest(request: Request, fallback: typeof fetch, requestHttps: typeof httpsRequest, redirects = 0): Promise<Response> {
  request.signal.throwIfAborted();
  const url = new URL(request.url);
  if (!isWorkday(url)) return fallback(request);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const headers = Object.fromEntries(request.headers);
  if (body && !request.headers.has("content-length")) headers["content-length"] = String(body.length);
  return new Promise<Response>((resolve, reject) => {
    const req = requestHttps(url, { method: request.method, headers, signal: request.signal }, async res => {
      try {
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const status = res.statusCode ?? 502;
        const location = responseHeaders.get("location");
        if (location && [301, 302, 303, 307, 308].includes(status) && request.redirect !== "manual") {
          res.on("error", () => {}); // The discarded redirect body must not produce an unhandled socket error.
          res.resume();
          if (request.redirect === "error") throw new TypeError("Redirect disallowed");
          if (redirects >= 20) throw new TypeError("Too many redirects");
          const nextUrl = new URL(location, url);
          // Avoid forwarding credentials across origins, matching fetch's redirect behavior.
          const nextHeaders = new Headers(request.headers);
          if (nextUrl.origin !== url.origin) {
            for (const name of ["authorization", "proxy-authorization", "cookie", "host"]) nextHeaders.delete(name);
          }
          const toGet = (status === 303 && request.method !== "HEAD") || ([301, 302].includes(status) && request.method === "POST");
          if (toGet) for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) nextHeaders.delete(name);
          const next = new Request(nextUrl, {
            method: toGet ? "GET" : request.method, headers: nextHeaders,
            body: toGet || !body ? undefined : new Uint8Array(body),
            signal: request.signal, redirect: request.redirect,
          });
          const response = await workdayRequest(next, fallback, requestHttps, redirects + 1);
          Object.defineProperty(response, "redirected", { value: true, configurable: true });
          resolve(response);
          return;
        }
        const noBody = request.method === "HEAD" || [204, 205, 304].includes(status);
        const encoding = noBody ? undefined : responseHeaders.get("content-encoding")?.toLowerCase();
        const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
        const stream = decoder ? res.pipe(decoder) : res;
        // Forward socket failures to the decompressor rather than leaving it waiting.
        if (decoder) res.on("error", error => decoder.destroy(error));
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        request.signal.throwIfAborted();
        if (decoder) {
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
        }
        const response = new Response(noBody ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers: responseHeaders });
        Object.defineProperty(response, "url", { value: url.href });
        resolve(response);
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on("error", reject);
    req.end(body);
  });
}

export function createPipelineFetch(fallback: typeof fetch = globalThis.fetch.bind(globalThis), requestHttps: typeof httpsRequest = httpsRequest): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!isWorkday(url)) return fallback(input, init);
    return workdayRequest(new Request(input, init), fallback, requestHttps);
  };
}
