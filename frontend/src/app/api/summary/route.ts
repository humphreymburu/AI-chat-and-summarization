const backendUrl =
  process.env.UNEP_AI_BACKEND_URL ||
  process.env.NEXT_PUBLIC_UNEP_AI_BACKEND_URL ||
  "http://127.0.0.1:8000";

// Forwards the summary request to the backend /search endpoint.
export async function POST(req: Request) {
  try {
    const response = await fetch(`${backendUrl.replace(/\/$/, "")}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Backend summary unavailable",
      },
      { status: 502 }
    );
  }
}
