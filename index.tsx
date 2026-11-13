import { createFileRoute } from "@tanstack/react-router";
import { StatusBoardView } from "@/components/status-board";
import { getCloudStatus } from "@/lib/status/get-status";

export const Route = createFileRoute("/")({
  loader: () => getCloudStatus(),
  staleTime: 20_000,
  component: Home,
});

function Home() {
  const board = Route.useLoaderData();
  return <StatusBoardView board={board} />;
}
