import { Suspense } from "react";
import { OrdersWorkspace } from "@/components/orders-v2/OrdersWorkspace";

export default function OrdersPage() {
  return (
    <Suspense fallback={<p>Загрузка…</p>}>
      <OrdersWorkspace />
    </Suspense>
  );
}
