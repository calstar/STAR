/**
 * Next.js API route that proxies config requests to backend
 */

export async function GET() {
  try {
    const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:8082';
    const response = await fetch(`${backendUrl}/api/config`);

    if (!response.ok) {
      throw new Error('Failed to fetch config');
    }

    const data = await response.json();
    return Response.json(data);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:8082';
    const body = await request.json();

    const response = await fetch(`${backendUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to save config');
    }

    const data = await response.json();
    return Response.json(data);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}



