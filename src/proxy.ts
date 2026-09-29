import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  decideCanonicalHost,
  resolveRequestHostname,
} from "@/server/http/canonical-host";

/**
 * Server-side canonical host enforcement (Next.js 16 `proxy`).
 * Redirects brand-alias browser navigation to APP_URL.
 * Does not expand Better Auth trustedOrigins.
 */
export function proxy(request: NextRequest) {
  const decision = decideCanonicalHost({
    method: request.method,
    hostname: resolveRequestHostname(request.headers),
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    appUrl: process.env.APP_URL,
  });

  if (decision.action === "pass") {
    return NextResponse.next();
  }

  if (decision.action === "redirect") {
    return NextResponse.redirect(decision.location, decision.status);
  }

  return NextResponse.json(
    { error: { code: decision.code, message: decision.message } },
    { status: decision.status },
  );
}

export const config = {
  matcher: [
    /*
     * Run on app pages and APIs; skip Next internals and static assets.
     * Health/webhook exemptions are handled inside decideCanonicalHost.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
