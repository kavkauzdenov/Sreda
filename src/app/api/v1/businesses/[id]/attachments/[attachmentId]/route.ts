import { getRuntime } from "@/server/runtime";
import { createApplication } from "@/server/http/application";
import { respond } from "@/server/http/errors";
import { AttachmentService } from "@/server/attachments/service";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  return respond(request, async () => {
    const r = getRuntime();
    const user = await createApplication(r).requireUser(request.headers);
    const p = await params;
    const file = await new AttachmentService(r.db, r.secret).file(
      user.id,
      p.id,
      p.attachmentId,
    );
    const inline =
      new URL(request.url).searchParams.get("inline") === "1" &&
      file.type === "image";
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });
}
