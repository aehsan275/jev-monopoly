import ReplayView from "./replay-view";

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReplayView id={id} />;
}
