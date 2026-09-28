// Deliberately vulnerable toy HTTP handler; always bind test servers to loopback.
export function handle(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname !== "/private") return new Response("missing", { status: 404 });
  if (request.headers.get("x-demo-key") !== "demo-key") return new Response("private:report");
  return new Response("private:report");
}
