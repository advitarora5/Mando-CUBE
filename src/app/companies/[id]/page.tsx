import { requirePageSession } from "@/server/auth/session";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getCompanyDetail } from "@/server/repositories/company-detail";
import { Detail } from "@/features/company-detail/detail";

export const dynamic = "force-dynamic";
export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageSession();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const company = await getCompanyDetail(id);
  if (!company) notFound();
  return <Detail company={company} />;
}
