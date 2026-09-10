export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export function getRole(request: Request): "warehouse" | "quality" | null {
  const role = request.headers.get("x-role");
  return role === "warehouse" || role === "quality" ? role : null;
}
