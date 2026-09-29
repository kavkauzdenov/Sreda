import { NextResponse } from "next/server";

const FAVICON_URL = "/assets/soty/brand/favicon.svg?v=4";

export function GET(request: Request) {
  const target = new URL(FAVICON_URL, request.url);
  const response = NextResponse.redirect(target, 307);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
