import { notFound } from "next/navigation";
import { IssuePage } from "@/components/discussion";
export default async function Page({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  if (
    !/^\d+$/.test(number) ||
    !Number.isSafeInteger(Number(number)) ||
    Number(number) < 1
  )
    notFound();
  return <IssuePage number={Number(number)} />;
}
