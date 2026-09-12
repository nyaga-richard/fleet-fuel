// Frontend health endpoint — used by the Docker HEALTHCHECK and deploy
// scripts to verify the web container is serving.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    status: 'ok',
    service: 'fleet-fuel-web',
    version: process.env.APP_VERSION || '1.0.0',
    commit: process.env.GIT_COMMIT || 'unknown',
  });
}
