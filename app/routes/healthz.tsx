export const loader = async () =>
  new Response("ok", {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });

export default function HealthCheck() {
  return null;
}
