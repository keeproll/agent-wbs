/** `GET /health` */
export interface HealthResponse {
  status: 'ok';
}

/** `GET /health/db` */
export interface DbHealthResponse {
  db: 'ok';
  latencyMs: number;
}
