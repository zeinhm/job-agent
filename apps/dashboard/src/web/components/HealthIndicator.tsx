import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";

export function HealthIndicator() {
  const { data, isError, isPending } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 30_000,
  });
  const label = isPending ? "checking" : isError || !data?.ok ? "down" : "ok";
  return <span role="status">Server: {label}</span>;
}
