import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LeadSetupWizard } from "@/components/leads/LeadSetupWizard";
import { getSolutionByCode } from "@/services/solutions.service";

export const metadata: Metadata = { title: "Настройка приёма заявок" };

export default async function LeadsSetupPage() {
  const solution = await getSolutionByCode("leads");
  if (!solution) notFound();
  return <LeadSetupWizard price={solution.price} />;
}
