import packageJson from "../../../../package.json";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      version: packageJson.version,
      commit: process.env.APP_BUILD_SHA || "unknown",
      builtAt: process.env.APP_BUILD_TIME || "unknown",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
