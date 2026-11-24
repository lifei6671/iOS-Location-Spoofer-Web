/**
 * Copyright (c) 2026 akudamatata (https://github.com/akudamatata/iOS-Location-Spoofer-Web)
 * Licensed under CC BY-NC-SA 4.0
 * 本项目免费开源，严禁二次售卖。
 */

export async function renderPlugin({ request, env }) {
  const response = await env.ASSETS.fetch(request);
  if (!response.ok) {
    return new Response('Not found', { status: 404 });
  }

  const url = new URL(request.url);
  const host = request.headers.get('host') || url.host;
  const protocol = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const token = encodeURIComponent(url.searchParams.get('token') || '');
  let content = await response.text();
  content = content.replace(/你的域名/g, () => host);
  content = content.replace(/你的Token/g, () => token);

  if (protocol === 'https') {
    content = content.replace(/http:\/\/localhost:8080/g, () => 'https://' + host);
  }

  return new Response(content, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}
