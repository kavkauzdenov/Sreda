import { ordersHandler } from "@/server/http/orders-handler";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  const p = await params;
  return ordersHandler(request, p.id, "orders", p.orderId);
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  const p = await params;
  return ordersHandler(request, p.id, "orders", p.orderId);
}
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  const p = await params;
  return ordersHandler(request, p.id, "orders", p.orderId);
}
